var genji = require('genji');
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
var Stream = require('stream');

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
   * Save an image doc into database
   * @param {Object} imageDoc
   * @return {Deferrable}
   */
  saveImageDoc:function (imageDoc) {
    var self = this;
    if (imageDoc.data instanceof Buffer) {
      var id = sha1(imageDoc.data);
      return self.imageCollection.findOne({_id: id}, {_id: 1})
        .and(function (defer, existedImage) {
          if (existedImage) {
            return true;
          } else {
            var imageModel = new ImageModel(imageDoc);
            if (imageModel.isValid()) {
              var imageDoc_ = ImageModel.toDoc(imageDoc);
              if (!imageDoc_.width || !imageDoc_.height) {
                defer.error('Missing width/height info of image.');
                return;
              }
              imageDoc_.data = new Binary(imageDoc_.data);
              imageDoc_.length = imageDoc_.data.length();
              self.imageCollection
                .insert(imageDoc_, {safe: true})
                .fail(defer.error)
                .then(function (inserted) {
                  if (inserted) {
                    defer.next(inserted[0]);
                  } else {
                    defer.error('Failed to save image doc.');
                  }
                });
            } else {
              defer.error(imageModel.getInvalidFields());
            }
          }
        });
    }
    return false;
  },

  saveImageStream: function (imageDoc, callback) {
    var stream = imageDoc.data;
    if (stream instanceof Stream && !isNaN(imageDoc.length)) {
      var self = this;
      gm(stream).identify({bufferStream: true}, function (err, info) {
        if (err) {
          callback(err);
          return;
        }
        if (info && info.size) {
          imageDoc.width = info.size.width;
          imageDoc.height = info.size.height;
          var type = info.type || info.Type;
          type = type.toLowerCase();
          type = type === 'jpeg' || /JPEG/.test(info.format) ? 'jpg' : type;
          imageDoc.type = type;
          imageDoc.meta = info;

          var buffer = new Buffer(imageDoc.length);
          var offset = 0;

          stream.on('data', function (chunk) {
            chunk.copy(buffer, offset, 0, chunk.length);
            offset += chunk.length;
          });

          stream.on('end', function () {
            imageDoc.data = buffer;
            self.saveImageDoc(imageDoc).then(function (doc) {
              callback(null, doc);
            }).fail(function (err) {
              callback(err);
            });
          });
          this.buffer.resume();
        } else {
          callback('Error: GM can not get image info');
        }
      });
    }
    return false;
  },

  /**
   * Grab and save a image to db
   *
   * @param url
   * @return {Deferrable}
   */
  saveImageFromUrl:function (url) {
    throw new Error('under development');
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
        gm(filePath).identify(function (err, info) {
          if (err) {
            defer.error(err);
            return;
          }
          if (info && info.size) {
            imageDoc.width = info.size.width;
            imageDoc.height = info.size.height;
            var type = info.type || info.Type;
            type = type.toLowerCase();
            type = type === 'jpeg' || /JPEG/.test(info.format) ? 'jpg' : type;
            imageDoc.type = type;
            imageDoc.meta = info;
            imageDoc.data = data;
            self.saveImageDoc(imageDoc).then(defer.next).fail(defer.error);
          } else {
            defer.error('Error: GM can not get image info');
          }
        });
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
  resize: function (imageDoc, options) {
    var self = this;
    var queryDoc = {
      date: imageDoc.date,
      filename: imageDoc.filename
    };
    console.log(queryDoc);
    var resized = this.imageCollection.findOne(queryDoc, {fields:this.defaultFields})
      .and(function (defer, imageFound) {
        if (imageFound) {
          return true;
        } else {
          self.loadImageToPath(imageDoc).then(defer.next).fail(defer.error);
        }
      });

    if (!options.hasOwnProperty('watermark') && this.autoWatermarkOnResize) {
      options.watermark = '1';
    }
    // embed watermark
    if (options.watermark === '1' && this.watermarkPath && options.width > this.minWatermarkImageWidth) {
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
        self.resizeImageAtPath(filePath, options.quality, options.width, options.height, function (err, filePath) {
          console.log(4);
          console.log(filePath);
          err ? defer.error(err) : defer.next(imageDoc, filePath);
        });
      })
      .and(function (defer, imageDoc, filePath) {
        if (!filePath) return true;
        console.log(5);
        console.log(imageDoc);
        console.log(filePath);
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
              console.log(2);
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
    if (!height || Number(height) === 0) {
      height = undefined;
    }
    console.log(arguments);
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