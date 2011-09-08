var genji = require('genji').short();
var db = genji.db;
var extend = genji.extend;
var Client = genji.require('client').Client;
var crypto = genji.require('crypto');
var path = require('path');

var exec = require('child_process').exec;
var fs = require('fs');
var gm = require('gm');


function ImageProcesser(db, options) {
  var options_ = extend({}, {rootCollection: 'images', tmpDir: '/tmp'}, options);
  // mongodb-async GridFS object
  this.imageFS = db.gridfs(options_.rootCollection);
  // mongodb-async collection object
  this.imageFC = db.collection(options_.rootCollection+'.files');
  this.tmpDir = options_.tmpDir;
  var self = this;
  // ensure index
  process.nextTick(function() {
  self.imageFC.ensureIndex({metadata: 1});
});
}

ImageProcesser.prototype = {
  saveImageFromUrl: saveImageFromUrl,
  compress: compress,
  resize: resize
}

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
  var metadata = {url: url, type: 'original'};
  var self = this;
  return this.imageFC.findOne({metadata: metadata}).and(function(defer, imageFound) {
    if (!imageFound) {
      var client = new Client(url);
      client.get().then(function(data, response) {
          if (response.statusCode !== 200) {
            defer.error('Failed to save image for url ' + url + ' \n Server return status code ' + response.statusCode);
            return;
          }
          var options = {contentType: imageType.contentType, metadata: metadata};
          var filename = getUniqueImageName(metadata);
          saveImageFromData.call(self, defer, filename, data, options);
        }).fail(defer.error);
    } else {
      defer.next(imageFound);
    }
  });
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
  var filename = imageDoc.filename;
  var metadata = extend({}, imageDoc.metadata, {quality: quality, type: 'compressed'});
  var compressedFilename = getUniqueImageName(metadata);
  var tmpFilePath;
  this.imageFC.findOne({filename: compressedFilename}).and(
    function(defer, imageFound) {
      if (imageFound) {
        outerDefer.next(imageFound);
      } else {
        loadImageToPath.call(self, defer, filename);
      }
    })
    .and(function(defer, filename, filePath) {
      compressImageAtPath(defer, filePath, quality);
    })
    .and(function(defer, filePath, quality) {
      saveImageFromFile.call(self, defer, compressedFilename, filePath,
        {metadata: metadata, contentType: imageDoc.contentType});
      tmpFilePath = filePath;
    })
    .and(function(defer, options) {
      removeFile(defer, tmpFilePath);
    })
    .and(function(defer) {
      var resultDoc = {filename: compressedFilename, metadata: metadata, contentType: imageDoc.contentType};
      outerDefer.next(resultDoc);
    })
    .fail(outerDefer.error);
}


function resize(imageDoc, options, outerDefer) {
  var metadata = extend({}, imageDoc.metadata);
  metadata.size = options.width + 'x' + options.height;
  metadata.quality = options.quality;
  metadata.type = 'resized';
  var resizedName = getUniqueImageName(metadata);
  var resizedPath;
  var contentType = imageDoc.contentType;

  var self = this;
  
  return this.imageFC.findOne({filename: resizedName})
    .and(function(defer, doc) {
      if (doc) {
        outerDefer.next(doc);
      } else {
        var filename = imageDoc.filename;
        loadImageToPath.call(self, defer, filename);
      }
    })
    .and(function(defer, filename, filePath) {
      resizedPath = filePath;
      gm(filePath)
        .resize(options.width, options.height)
        .noProfile()
        .quality(options.quality || 100)
        .write(resizedPath, function(err) {
          if (err) {
            defer.error(err);
            return;
          }
          saveImageFromFile.call(self, defer, resizedName, resizedPath, {metadata: metadata, contentType: contentType});
        });
    })
    .and(function(defer, options) {
      removeFile(defer, resizedPath);
    })
    .and(function(defer) {
      var resultDoc = {filename: resizedName, metadata: metadata, contentType: contentType};
      outerDefer.next(resultDoc);
    })
    .fail(outerDefer.error);
}


/**
 * Private async operation functions
 */

function saveImageFromData(defer, filename, data, options) {
  var options_ = {
    content_type: options.contentType,
    metadata: options.metadata
  };
  this.imageFS
    .open(filename, 'w', options_)
    .write(data)
    .then(function() {
      defer.next({filename: filename, metadata: options.metadata, contentType: options.contentType});
    })
    .fail(defer.error);
  // thenCall(defer.next, {param: 1});
  // andCall(defer.next, {xxx: 1}
}

function saveImageFromFile(defer, filename, filePath, options) {
  var options_ = {
    content_type: options.contentType,
    metadata: options.metadata
  };
  this.imageFS
    .open(filename, 'w', options_)
    .writeFile(filePath)
    .then(function() {
      options.filename = filename;
      defer.next(options);
    }).fail(defer.error);
}

function loadImageToPath(defer, filename, filePath) {
  filePath = filePath || path.join(this.tmpDir, filename);
  this.imageFS.read(filename).then(
    function(data) {
      fs.writeFile(filePath, data, 'binary', function(err) {
        if (err) {
          var errMsg = ['Failed to load image', filename, 'to path', filePath];
          defer.error(errMsg.join(' ') + '\n' + (err.stack || err));
          return;
        }
        defer.next(filename, filePath);
      });
    }).fail(defer.error);
}

function compressImageAtPath(defer, filePath, quality) {
  var jpegoptim = ['jpegoptim', '-m' + quality, filePath];
  cmdExec(defer, jpegoptim.join(' '), function() {
    defer.next(filePath, quality);
  });
}

function removeFile(defer, filePath) {
  fs.unlink(filePath, function (err) {
    if (err) {
      defer.error(err.stack || err);
      return;
    }
    defer.next();
  });
}

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

function getUniqueImageName(metadata) {
  return crypto.md5(imageMetaStr(metadata));
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

function imageMetaStr(metadata) {
  var str = [];

  function appendStr(key) {
    if (metadata[key]) {
      str.push(key, metadata[key]);
    }
  }

  appendStr('url');
  appendStr('type');
  appendStr('quality');
  appendStr('size');
  return str.join('_');
}