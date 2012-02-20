var genji = require('genji').short();
var db = genji.db;
var extend = genji.extend;
var Client = genji.require('client').Client;
var crypto = genji.require('crypto');
var sha1 = crypto.sha1;
var path = require('path');
var mongodbAsync = require('mongodb-async');
var Binary = mongodbAsync.mongodb.BSONPure.Binary;

var exec = require('child_process').exec;
var fs = require('fs');
var readFile = genji.defer(fs.readFile, fs);
var gm = require('gm');



/**
 * Image collection:
 *
 * {
 *   _id: '441547af33d49c4f37461fa87a5bb502b40687f2', // sha1 hash of the file content
 *   filename: '441547af33d49c4f37461fa87a5bb502b40687f2_100_200x300', // filename
 *   coarseLoc: '201201', // the first sharding key, default is the month when the image is created
 *   data: '', // image binary data
 *   type: 'image/jpeg', // mime type
 *   length: 77031, // binary length of image
 *   created: ISODate("2011-08-27T17:45:29.976Z"), // date created
 *   url: 'http://p0.meituan.net/deal/201108/24/shotu1.jpg', // url of oringinal image (optional)
 *   quality: 100, // image quality (optional),
 *   width: 200, // image width in px (optional)
 *   height: 300 // image height in px (optional)
 * }
 *
 * filename: (hash-of-original-file)_(quality)_(widthxheight)
 * Quality 100 not resized (lossless compressed): 441547af33d49c4f37461fa87a5bb502b40687f2_100
 * Quality 70, resized 200x300: 441547af33d49c4f37461fa87a5bb502b40687f2_70_200x300
 *
 */


/**
 *
 * @param db
 * @param options
 */
function ImageProcesser(db, options) {
  var options_ = extend({}, {collection: 'lazy_images', tmpDir: '/tmp'}, options);
  // mongodb-async collection object
  this.dbCollection = db.collection(options_.collection);
  this.tmpDir = options_.tmpDir;
  var self = this;
  // ensure index
  process.nextTick(function() {
    self.dbCollection.ensureIndex({coarseLoc: 1, filename: 1, url: 1});
  });
  this.defaultFields = {
    filename: 1,
    type: 1,
    length: 1,
    quality: 1,
    width: 1,
    height: 1,
    url: 1,
    coarseLoc: 1
  };
}

ImageProcesser.prototype = {
  saveImageFromUrl: saveImageFromUrl,
  saveImageFileAndRemove: saveImageFileAndRemove,
  compress: compress,
  resize: resize,
  loadImageToPath: loadImageToPath,
  compressImageAtPath: compressImageAtPath,
  resizeImageAtPath: resizeImageAtPath,
  getCoarseLoc: function() {
    var date = new Date;
    var year = date.getUTCFullYear();
    var month = date.getUTCMonth() + 1;
    if (month < 10) {
      month = '0' + month;
    }
    return year + '' + month;
  }
};

exports.ImageProcesser = ImageProcesser;

/**
 * Public APIs
 */

/**
 * Grab and save a image to db
 *
 * @param url
 */
function saveImageFromUrl(url) {
  var imageType = typeOfImage(url);
  var self = this;
  return this.dbCollection.findOne({url: url}, {fields: this.defaultFields}).and(function(defer, imageFound) {
    if (!imageFound) {
      var client = new Client(url);
      client.get().then(
        function(data, response) {
          if (response.statusCode !== 200) {
            defer.error('Failed to save image for url ' + url + ' \n Server return status code ' + response.statusCode);
            return;
          }
          var imageDoc = {type: imageType.contentType, url: url};
          saveImageData.call(self, defer, data, imageDoc);
        }).fail(defer.error);
    } else {
      defer.next(imageFound);
    }
  });
}

/**
 * Read file from `filePath` and save to database
 * 
 * @param {String} filePath
 */
function saveImageFileAndRemove(filePath, options, outerDefer) {
  var self = this;
  options = options || {};
  var imageDoc;
  var deferred = readFile(filePath).and(
    function(defer, data) {
      saveImageData.call(self, defer, data, options);
    }).and(function(defer, _imageDoc) {
      imageDoc = _imageDoc;
      removeFile(defer, filePath);
    }).and(function(defer) {
      (outerDefer || defer).next(imageDoc);
    });
  return deferred;
}

/**
 * Compress a image file in db
 *
 * @param filename
 * @param quality
 */
function compress(imageDoc, quality, outerDefer) {
  var self = this;
  quality = quality || 100;
  var imageDoc_ = setImageDocOption(imageDoc, {
    quality: quality
  });
  var filename = generateFilename(imageDoc_);
  this.dbCollection.findOne({filename: filename}, {fields: this.defaultFields}).and(
    function(defer, imageFound) {
      if (imageFound) {
        // we already have this image compressed with this quality
        outerDefer.next(imageFound);
      } else {
        var fileToLoad = quality === 100 ? imageDoc_._id : filename;
        loadImageToPath.call(self, defer, fileToLoad);
      }
    })
    .and(function(defer, filename, filePath) {
      compressImageAtPath(defer, filePath, quality);
    })
    .and(function(defer, filePath, quality) {
      self.saveImageFileAndRemove(filePath, imageDoc_, defer);
    })
    .and(function(defer, compressedImageDoc) {
      delete compressedImageDoc.data;
      outerDefer.next(compressedImageDoc);
    })
    .fail(outerDefer.error);
}

/**
 * 
 * @param imageDoc
 * @param options
 * @param outerDefer
 */
function resize(imageDoc, options, outerDefer) {
  options.quality = options.quality || 100;
  var imageDoc_ = setImageDocOption(imageDoc, options);
  var filename = generateFilename(imageDoc_);
  var self = this;
  this.dbCollection.findOne({filename: filename}, {fields: this.defaultFields})
    .and(function(defer, doc) {
      if (doc) {
        outerDefer.next(doc);
      } else {
        var fileToLoad = options.quality === 100 ? imageDoc_._id : filename;
        loadImageToPath.call(self, defer, fileToLoad);
      }
    })
    .and(function(defer, filename, filePath) {
      self.resizeImageAtPath(defer, filePath, options.quality, options.width, options.height);
    })
    .and(function(defer, filePath) {
      self.saveImageFileAndRemove(filePath, imageDoc_, defer);
    })
    .and(function(defer, resizedImageDoc) {
      delete resizedImageDoc.data;
      outerDefer.next(resizedImageDoc);
    })
    .fail(outerDefer.error);
}


/**
 * Private async operation functions
 */

/**
 * 
 * @param defer
 * @param {Buffer} data
 * @param options
 */
function saveImageData(defer, data, imageDoc) {
  if (!Buffer.isBuffer(data)) {
    defer.error('Only Buffer is allowed');
    return;
  }
  
  var imageBlob = new Binary(data);
  var doc = extend({coarseLoc: this.getCoarseLoc()}, imageDoc, {
    data: imageBlob,
    length: imageBlob.length(),
    created: new Date
  });
  
  if (doc._id) {
    // compressed or resized file, compose filename with original file _id
    doc.filename = generateFilename(doc);
    doc._id = sha1(data);
  } else {
    doc._id = sha1(data);
    doc.filename = generateFilename(doc);
  }
  if (doc._id !== doc.filename) {
    // save source url only for original file
    delete doc.url;
  }
  this.dbCollection
    .insert(doc, {safe: true})
    .then(function(inserted) {
      if (inserted)
        defer.next(inserted[0]);
    })
    .fail(defer.error);
}

/**
 * 
 * @param defer
 * @param filename
 * @param filePath
 */
function loadImageToPath(defer, filename, filePath) {
  filePath = filePath || path.join(this.tmpDir, filename);
  var _id = filename.split('_')[0];
  this.dbCollection.findOne({_id: _id}, {fields:{data: 1}}).then(
    function(imageDoc) {
      if (imageDoc) {
        fs.writeFile(filePath, imageDoc.data.buffer, function(err) {
          if (err) {
            var errMsg = ['Failed to load image', filename, 'to path', filePath];
            defer.error(errMsg.join(' ') + '\n' + (err.stack || err));
            return;
          }
          defer.next(filename, filePath);
        });
      } else {
        defer.error('Image not found');
      }
    }).fail(defer.error);
}

/**
 * 
 * @param defer
 * @param filePath
 * @param quality
 */
function compressImageAtPath(defer, filePath, quality) {
  var jpegoptim = ['jpegoptim', '-m' + quality, '--strip-all', filePath];
  cmdExec(defer, jpegoptim.join(' '), function() {
    defer.next(filePath, quality);
  });
}

function resizeImageAtPath(defer, filePath, quality, width, height) {
  gm(filePath)
    .resize(width, height)
    .noProfile()
    .quality(quality)
    .write(filePath, function(err) {
      if (err) {
        defer.error(err);
        return;
      }
      defer.next(filePath);
    });
}

/**
 * 
 * @param defer
 * @param filePath
 */
function removeFile(defer, filePath) {
  fs.unlink(filePath, function (err) {
    if (err) {
      defer.error(err);
      return;
    }
    defer.next();
  });
}

/**
 * 
 * @param defer
 * @param cmd
 * @param callback
 */
function cmdExec(defer, cmd, callback) {
  exec(cmd, function(err, stdout, stderr) {
    if (err) {
      defer.error(err);
      return;
    }
    callback && callback();
  });
}

// helpers

function generateFilename(imageDoc) {
  var filename = imageDoc._id;
  if (imageDoc.quality) {
    filename += '_' + imageDoc.quality;
  }
  if (imageDoc.width && imageDoc.height) {
    filename += '_' + imageDoc.width + 'x' + imageDoc.height;
  }
  return filename;
}

function typeOfImage(url) {
  try {
    switch (path.extname(url)) {
      case '.jpg':
      case '.jpeg':
        return {ext: '.jpg', contentType: 'image/jpeg'};
      case '.png':
        return {ext: '.png', contentType: 'image/png'};
      case '.gif':
        return {ext: '.gif', contentType: 'image/gif'};
      default:
        return false;
    }
  } catch(e) {
    console.error('Failed to get ext name form url: %s', url);
    console.error(e.stack || e);
  }
  return {ext: '.jpg', contentType: 'image/jpeg'};
}

function setImageDocOption(doc, options) {
  if (!options) return doc;
  var retDoc = extend({}, doc);
  if (options.url) retDoc.url = options.url;
  if (options.quality) {
    retDoc.quality = Number(options.quality);
  }
  if (options.width && options.height) {
    retDoc.width = Number(options.width);
    retDoc.height = Number(options.height);
  }
  return retDoc;
}