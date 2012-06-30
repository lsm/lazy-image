var genji = require('genji').short();
var extend = genji.extend;
var Client = genji.client.Client;
var sha1 = genji.crypto.sha1;
var path = require('path');
var mongodbAsync = require('mongodb-async');
var connect = mongodbAsync.connect;
var Binary = mongodbAsync.mongodb.BSONPure.Binary;

var exec = require('child_process').exec;
var fs = require('fs');
var readFile = genji.defer(fs.readFile, fs);
var gm = require('gm');

var model = require('./model');
var ImageModel = model.ImageModel;


/**
 * Image collection:
 *
 * {
 *   _id: '441547af33d49c4f37461fa87a5bb502b40687f2', // sha1 hash of the file content
 *   filename: '441547af33d49c4f37461fa87a5bb502b40687f2_100_200x300', // filename
 *   coarseLoc: '20120618', // the first sharding key, default is the date when the image is created
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
 * @param options
 * @param db
 */
function ImageProcesser(options, db) {
  var options_ = extend({}, {dbCollection:'lazy_images', tmpDir:'/tmp'}, options);
  // mongodb-async collection object
  if (!db) {
    db = connect(options_.dbHost, options_.dbPort, {poolSize:options_.dbPoolSize}).db(options_.dbName, {});
  }
  this.imageCollection = db.collection(options_.dbCollection);
  this.tmpDir = options_.tmpDir;
  this.privateKey = options_.privateKey;
  this.denyOriginal = options_.denyOriginal;
  this.watermarkPath = options_.watermarkPath;
  this.autoWatermarkOnResize = options_.autoWatermarkOnResize;
  this.minWatermarkImageWidth = options_.minWatermarkImageWidth || 460;
  var self = this;
  // ensure index
  process.nextTick(function () {
    self.imageCollection.ensureIndex({date:1, filename:1, _id: 1}, {unique: true, background: true});
  });
  this.defaultFields = {
    date:1,
    filename:1,
    type:1,
    length:1,
    quality:1,
    width:1,
    height:1,
    url:1,
    watermark: 1,
    created:1
  };
}

ImageProcesser.prototype = {
  /**
   *
   * @param {Object} imageDoc
   * @param options
   * @return {Deferrable}
   */
  saveImageDoc:function (imageDoc) {
    var imageModel = new ImageModel(imageDoc);
    var imageDoc_ = imageModel.toDoc();
    imageDoc_.data = new Binary(imageDoc_.data);
    imageDoc.length = imageDoc_.data.length();
    var self = this;
    return this.imageCollection.findOne({_id:imageDoc_._id})
      .and(function (defer, oldDoc) {
        if (oldDoc) {
          return true;
        } else {
          self.imageCollection
            .insert(imageDoc_, {safe:true})
            .fail(defer.error)
            .then(function (inserted) {
              if (inserted) {
                defer.next(inserted[0]);
              } else {
                defer.error('Failed to save image doc.');
              }
            });
        }
      });
  },

  /**
   * Grab and save a image to db
   *
   * @param url
   * @return {Deferrable}
   */
  saveImageFromUrl:function (url) {
    var imageType = typeOfImage(url);
    var self = this;
    var urlHash = sha1(url);
    return this.imageCollection.findOne({filename: new RegExp('^' + urlHash + '_')}, {fields:this.defaultFields}).and(function (defer, imageFound) {
      if (!imageFound) {
        var client = new Client(url);
        client.get().then(
          function (data, response) {
            if (response.statusCode !== 200) {
              defer.error('Failed to save image for url ' + url + ' \n Server return status code ' + response.statusCode);
              return;
            }
            var imageModel = new ImageModel({
              filename: urlHash,
              data:data,
              type:imageType.contentType,
              url:url
            });
            if (imageModel.isValid()) {
              self.saveImageDoc(imageModel.toDoc()).then(defer.next).fail(defer.error);
            } else {
              defer.error(imageModel.getInvalidFields());
            }
          }).fail(defer.error);
      } else {
        defer.next(imageFound);
      }
    });
  },

  /**
   * Read file from `filePath` and save to database
   *
   * @param {String} filePath
   * @return {Deferrable}
   */
  saveImageFile: function (filePath, imageDoc, unlink) {
    var self = this;
    imageDoc = imageDoc || {};
    return readFile(filePath)
      .and(function (defer, data) {
        imageDoc.data = data;
        var imageModel = new ImageModel(imageDoc);
        if (imageModel.isValid()) {
          self.saveImageDoc(imageModel.toDoc()).then(defer.next).fail(defer.error);
        } else {
          defer.error(imageModel.getInvalidFields());
        }
      }).and(function (defer, imageDoc) {
        if (!unlink) return true;
        fs.unlink(filePath, function (err) {
          if (err) {
            defer.error(err);
          } else {
            defer.next(imageDoc);
          }
        });
      });
  },

  /**
   * Read file from `filePath` and save to database
   *
   * @param {String} filePath
   * @return {Deferrable}
   */
  saveImageFileAndRemove: function (filePath, imageDoc) {
    return this.saveImageFile(filePath, imageDoc, true);
  },

  /**
     * Compress a image file in db
     *
     * @param imageDoc
     */
  compress: function (imageDoc) {
    var self = this;
    var queryDoc = {
      date: imageDoc.date,
      filename: imageDoc.filename
    };

    return this.imageCollection.findOne(queryDoc, {fields:this.defaultFields})
      .and(function (defer, imageFound) {
        if (imageFound) {
          // we already have this image compressed with this quality
          defer.next(imageFound);
        } else {
          self.loadImageToPath(imageDoc).then(defer.next).fail(defer.error);
        }
      })
      .and(function (defer, imageDoc, filePath) {
        self.compressImageAtPath(filePath, imageDoc.quality, function (err) {
          if (err) {
            defer.error(err);
          } else {
            defer.next(imageDoc, filePath);
          }
        });
      })
      .and(function (defer, imageDoc, filePath) {
        self.saveImageFileAndRemove(filePath, imageDoc).then(defer.next).fail(defer.error);
      })
      .and(function (defer, compressedImageDoc) {
        delete compressedImageDoc.data;
        defer.next(compressedImageDoc);
      });
  },

  /**
   *
   * @param imageDoc
   * @param imageDoc
   * @param outerDefer
   * @return {Deferrable}
   */
  resize: function (imageDoc) {
    var self = this;
    var queryDoc = {
      date: imageDoc.date,
      filename: imageDoc.filename
    };
    var resized = this.imageCollection.findOne(queryDoc, {fields:this.defaultFields})
      .and(function (defer, imageFound) {
        if (imageFound) {
          return true;
        } else {
          self.loadImageToPath(imageDoc).then(defer.next).fail(defer.error);
        }
      });

    if (!imageDoc.hasOwnProperty('watermark') && this.autoWatermarkOnResize) {
      imageDoc.watermark = '1';
    }
    // embed watermark
    if (imageDoc.watermark === '1' && this.watermarkPath && imageDoc.width > this.minWatermarkImageWidth) {
      var watermarkPath = '"' + this.watermarkPath + '"';
      resized.and(function (defer, imageDoc, filePath) {
        if (!filePath) return true;
        self.embedWatermarkAtPath(defer, filePath, watermarkPath, {
          dissolve:80,
          gravity:'center'
        });
      });
    }

    resized.and(function (defer, imageDoc, filePath) {
        if (!filePath) return true;
        self.resizeImageAtPath(filePath, imageDoc.quality, imageDoc.width, imageDoc.height, function (err, filePath) {
          defer.next(err, imageDoc, filePath);
        });
      })
      .and(function (defer, imageDoc, filePath) {
        if (!filePath) return true;
        self.saveImageFileAndRemove(filePath, imageDoc).then(defer.next).fail(defer.error);
      })
      .and(function (defer, resizedImageDoc) {
        delete resizedImageDoc.data;
        defer.next(resizedImageDoc);
      });
    return resized;
  },

  /**
   *
   * @param imageDoc
   * @param filePath
   */
  loadImageToPath:function (imageDoc, filePath) {
    filePath = filePath || path.join(this.tmpDir, imageDoc.filename || imageDoc._id);
    var queryDoc = {
      date: imageDoc.date,
      _id: imageDoc._id
    };
    return this.imageCollection.findOne(queryDoc, {fields:{data:1}})
      .and(function (defer, imageDoc) {
        if (imageDoc) {
          fs.writeFile(filePath, imageDoc.data.buffer, function (err) {
            if (err) {
              var errMsg = ['Failed to load image', imageDoc._id, 'to path', filePath];
              defer.error(errMsg.join(' ') + '\n' + (err.stack || err));
            } else {
              defer.next(imageDoc, filePath);
            }
          });
        } else {
          defer.error('Image not found');
        }
      });
  },

  /**
   *
   * @param filePath
   * @param quality
   * @param callback
   */
  compressImageAtPath: function (filePath, quality, callback) {
    gm(filePath).noProfile().quality(quality).write(filePath, function (err) {
      callback(err, filePath);
    });
  },

  resizeImageAtPath:function (filePath, quality, width, height, callback) {
    gm(filePath)
      .resize(width, height)
      .noProfile()
      .quality(quality)
      .write(filePath, function (err) {
        callback(err, filePath);
      });
  },

  embedWatermarkAtPath: function (filePath, watermarkPath, watermarkOptions, callback) {
    var watermarkOptions_ = watermarkOptions || {};
    var dissolve = watermarkOptions_.dissolve || 80;
    var gravity = watermarkOptions_.gravity || 'center';
    var gmCompositeCmd = ['gm composite -dissolve', dissolve, '-gravity', gravity, watermarkPath, filePath, filePath].join(' ');
    var self = this;
    if (watermarkOptions_.minWidth) {
      gm(filePath)
        .size(function (err, size) {
          if (!err) {
            if (watermarkOptions_.minWidth > size.width) {
              // must resize image before composite if `minWidth` is wider than image width
              self.resizeImageAtPath(filePath, 100, watermarkOptions_.minWidth, null, function (err, filePath) {
                if (!err) {
                  cmdExec(gmCompositeCmd, function (err) {
                    // after composited, resize back to original width
                    if (err) {
                      callback(err);
                    } else {
                      self.resizeImageAtPath(filePath, 100, size.width, size.height, function (err, filePath) {
                        callback(err, filePath);
                      });
                    }
                  });
                } else {
                  callback(err);
                }
              });
            } else {
              cmdExec(gmCompositeCmd, function (err) {
                callback(err, filePath);
              });
            }
          } else {
            callback(err);
          }
        });
    } else {
      cmdExec(gmCompositeCmd, function (err) {
        callback(err, filePath);
      });
    }
  }
};

exports.ImageProcesser = ImageProcesser;


// helpers

/**
 *
 * @param cmd
 * @param callback
 */
function cmdExec(cmd, callback) {
  exec(cmd, function (err, stdout, stderr) {
    if (err) {
      callback(err)
    } else {
      callback(null, stdout, stderr);
    }
  });
}

function typeOfImage(url) {
  try {
    switch (path.extname(url)) {
      case '.jpg':
      case '.jpeg':
        return {ext:'.jpg', contentType:'image/jpeg'};
      case '.png':
        return {ext:'.png', contentType:'image/png'};
      case '.gif':
        return {ext:'.gif', contentType:'image/gif'};
      default:
        return false;
    }
  } catch (e) {
    console.error('Failed to get ext name form url: %s', url);
    console.error(e.stack || e);
  }
  return {ext:'.jpg', contentType:'image/jpeg'};
}