/**
 * Dependencies
 */
var genji = require('genji');
var App = genji.App;
var extend = genji.extend;
var connect = require('mongodb-async').connect;
var ImageProcesser = require('./processer').ImageProcesser;
var IncomingForm = require('formidable').IncomingForm;
var sha1 = genji.crypto.sha1;
var BaseHandler = genji.handler.BaseHandler;
var Path = require('path');
var model = require('./model');
var ImageModel = model.ImageModel;
var fs = require('fs');


var ImageUploadApp = App('ImageUploadApp', {
  init:function (options) {
    var options_ = extend({}, ImageUploadApp.defaultOptions, options);
    var db = connect(options_.dbHost, options_.dbPort, {poolSize:options_.dbPoolSize}).db(options_.dbName, {});
    this.processer = new ImageProcesser(options_, db);
    db.open()
      .fail(function (err) {
        console.trace('Can not connect to mongodb with options: ');
        console.error(options_);
        throw err;
      });
    // upload options
    this.exts = options_.exts || ['.png', '.jpg', '.jpeg'];
    this.maxFieldsSize = options_.maxFieldsSize || 8388608; // 8MB
  },

  setAllowedExts:function (exts) {
    this.exts = exts;
    return this;
  },

  setMaxFieldsSize:function (size) {
    this.maxFieldsSize = size;
    return this;
  },

  isAllowedExt:function (filename) {
    return this.exts.indexOf(Path.extname(filename.toLowerCase())) > -1;
  },

  parseRequest:function (request, callback) {
    var form = new IncomingForm();
    var files = [];
    var fields = {};
    var self = this;
    form.maxFieldsSize = this.maxFieldsSize;
    form.keepExtensions = true;
    form
      .on('field', function (field, value) {
        var val = fields[field];
        if (val) {
          fields[field] = Array.isArray(val) ? val.concat(value) : [val, value];
        } else {
          fields[field] = value;
        }
      })
      .on('file', function (field, file) {
        if (self.isAllowedExt(file.name)) {
          file.field = field;
          files.push(file);
        } else {
          self.emit('error', 'Invalid file extention: ' + Path.extname(file.name));
        }
      })
      .on('end', function () {
        callback(null, fields, files.length > 0 ? files : null);
      })
      .on('error', function (err) {
        if (callback) {
          callback(err);
        } else {
          self.emit('error', err);
        }
      });
    form.parse(request);
  },

  saveImageFile:function (filePath, imageDoc, unlink) {
    var self = this;
    this.app.processer
      .saveImageFile(filePath, imageDoc, typeof unlink === 'undefined' ? true : unlink)
      .and(function (defer, resultImageDoc) {
        delete resultImageDoc.data;
        self.emit('saveImageFile', null, resultImageDoc);
      }).fail(function (err) {
        self.emit('saveImageFile', err);
      });
  },

  /**
   *
   * @param {Buffer} buffer
   * @param imageDoc
   */
  saveImageBlob:function (buffer, imageDoc) {
    var self = this;
    imageDoc.data = buffer;
    if (buffer instanceof Buffer) {
      this.app.processer.saveImageDoc(imageDoc)
        .then(function (resultImageDoc) {
          delete resultImageDoc.data;
          self.emit('saveImageBlob', null, resultImageDoc);
        }).fail(function (err) {
          self.emit('saveImageBlob', err);
        });
    } else {
      this.emit('saveImageBlob', 'Only support Buffer.');
    }
  },

  routes:{
    uploadImageFile:{method:'post', url:'/upload/image/file', handleFunction:function (handler) {
      var self = this;
      this.app.parseRequest(handler.context.request, function (err, fields, files) {
        if (err) {
          self.emit('saveImageFile', err);
        } else if (!Array.isArray(files)) {
          self.emit('saveImageFile', 'Cannot parse file from request.');
        } else {
          var file = files[0];
          var imageDoc = {type:file.type};
          self.app.saveImageFile.call(self, file.path, imageDoc);
        }
      });
    }, handlerClass:BaseHandler},

    uploadImageBlob:{method:'post', url:'/upload/image/blob', handleFunction:function (handler) {
      var request = handler.context.request;
      var len = Number(request.headers['content-length']);
      var name = request.headers['x-filename'];
      if (isNaN(len)) {
        this.emit('saveImageBlob', "header has no content length");
      } else {
        var seed = [process.pid, len, name, (new Date).getTime()].join('-');
        var tmpPath = Path.join(this.app.processer.tmpDir, sha1(seed));
        var wStream = fs.createWriteStream(tmpPath);
        request.pipe(wStream);
        var self = this;
        request.on('end', function () {
          self.app.saveImageFile.call(self, tmpPath, {length: len, name: name}, true);
        });
      }
    }, handlerClass:BaseHandler}
  },

  routeResults:{
    saveImageFile:function (err, imageDoc) {
      if (err) {
        this.handler.error(500, 'upload failed');
        console.error(err.stack || err);
        return;
      }
      this.handler.sendJSON(imageDoc);
    },

    saveImageBlob:function (err, imageDoc) {
      if (err) {
        this.handler.error(500, 'upload failed');
        console.error(err.stack || err);
        return;
      }
      this.handler.sendJSON(imageDoc);
    }
  }

}, {
  defaultOptions:{
    dbName:'lazy_image_test',
    dbHost:'127.0.0.1',
    dbPort:27017,
    dbCollection:'images',
    dbPoolSize:10
  }
});


var ImageProcessApp = App('ImageProcessApp', {

  init:function (options) {
    var options_ = extend({}, ImageUploadApp.defaultOptions, options);
    var db = connect(options_.dbHost, options_.dbPort, {poolSize:options_.dbPoolSize}).db(options_.dbName, {});
    this.processer = new ImageProcesser(options_, db);
    db.open()
      .fail(function (err) {
        console.trace('Can not connect to mongodb with options: ');
        console.error(options_);
        throw err;
      });
  },

  getImageDoc:function (query) {
    var queryDoc;
    if (typeof query === 'string') {
      queryDoc = query.length === 40 ? {_id:query} : {filename:query};
    } else {
      queryDoc = query;
    }
    var self = this;
    this.app.processer
      .imageCollection.findOne(queryDoc)
      .then(function (imageDoc) {
        self.emit('getImageDoc', null, imageDoc);
      })
      .fail(function (err) {
        self.emit('getImageDoc', err);
      });
  },

  getImageByDateId:function (date, imageId, options) {
    var lazyProcess = false;
    var processer = this.app.processer;
    var origFilename = imageId;
    if (imageId.length === 40 && options.hash && (options.width || options.height)) {
      options.id = imageId;
      lazyProcess = isValidHash(options.hash, options, processer.privateKey);
      imageId = generateImageFilename(imageId, options);
    } else {
      // requesting original image file
      if (processer.denyOriginal) {
        this.emit('getImageById', 'Image not found');
        return;
      }
    }
    var self = this;
    var queryDoc = imageId.length === 40 ? {_id:imageId} : {filename:imageId};
    date && (queryDoc.date = date);
    this.app.processer
      .imageCollection.findOne(queryDoc).then(function (imageDoc) {
      if (imageDoc) {
        imageDoc.data = imageDoc.data.value();
        self.emit('getImageById', null, imageDoc);
      } else {
        if (lazyProcess) {
          // find the original image and resize
          processer.imageCollection.findOne({_id:origFilename}).and(
            function (defer, imageDoc) {
              if (!imageDoc) {
                self.emit('getImageById', 'Image not found');
              } else {
                imageDoc.filename = imageId;
                processer.resize(imageDoc, options).then(defer.next).fail(defer.error);
              }
            }).then(function (resizedDoc) {
              self.app.getImageDoc(resizedDoc._id, function (err, imageDoc) {
                if (err || !imageDoc) {
                  self.emit('getImageById', 'Image not found');
                } else {
                  imageDoc.data = imageDoc.data.value();
                  self.emit('getImageById', null, imageDoc);
                }
              });
            })
            .fail(function (err) {
              self.emit('getImageById', err);
            });
        } else {
          self.emit('getImageById', 'Image not found for id ' + imageId + ' in date ' + (date || ''));
        }
      }
    });
  },

  getImageById: function (imageId, options) {
    ImageProcessApp.prototype.getImageByDateId.call(this, null, imageId, options);
  },

  processImage: function(options) {
    var url = options.url;
    var processer = this.app.processer;
    var deferred = processer.saveImageFromUrl(url);
    var result = [];
    var originalDoc;
    var self = this;
    deferred.and(function (defer, imageDoc) {
        delete imageDoc.data;
        originalDoc = imageDoc;
        if (options.noLossless) {
          handler.sendJSON([imageDoc]);
          self.emit('processImage', null, [imageDoc]);
          return true;
        } else {
          //lossless compress
          result.push(imageDoc);
          processer.compress(imageDoc, 100, defer);
        }
      },
      function (defer, compressedDoc) {
        if (!options.noLossless) {
          result.push(compressedDoc);
        }
        if (options.width && options.height) {
          processer.resize(originalDoc, options, defer);
        } else {
          self.emit('processImage', null, result);
        }
      },
      function (defer, resizedDoc) {
        result.push(resizedDoc);
        self.emit('processImage', null, result);
      })
      .fail(function (err) {
        self.emit('processImage', err);
      });
  },

  routes:{
    getImageByDateId:{method:'get', url:'/([0-9]{8})/id/([0-9a-zA-Z]{40})\\.(?:jpg|png|gif)'},
    getImageById:{method:'get', url:'/([0-9a-zA-Z]{40})\\.(?:jpg|png|gif)'},
    processImage:{method: 'get', url: '/process'},
    notFound:{method: 'notFound', url: '^/*', handleFunction:function (handler) {
      handler.error(404, 'invalid endpoint');
      console.log('Invalid endpoint: ' + handler.context.request.url);
    }}
  },

  routeResults:{
    getImageById:function (err, imageDoc) {
      if (err || !imageDoc) {
        this.handler.error(404, 'Image not found');
        console.error(err.stack || err);
        return;
      }
      this.handler.sendAsFile(imageDoc.data, {type: imageDoc.type});
    },
    processImage:function (err, imageDocs) {
      if (err || !Array.isArray(imageDocs)) {
        this.handler.error(500, 'Image processing error');
        console.error(err.stack || err);
        return;
      }
      this.handler.sendJSON(imageDocs);
    }
  }

});


function generateImageHash(options, key) {
  if (!options.hasOwnProperty('watermark')) {
    options.watermark = '0';
  }
  options.quality = options.quality || '100';
  options.height = options.height || 0;
  return sha1([options.id, options.width, options.height, options.quality, options.watermark, key].join('_'));
}

function generateImageFilename(id, options) {
  options.quality = options.quality || '100';
  var filename = [id, options.quality, options.width + 'x' + options.height];
  if (options.watermark === '1') {
    filename.push('watermarked');
  }
  return filename.join('_');
}

function generateImageThumbUrl(options, key) {
  options.quality = options.quality || '100';
  var hash = generateImageHash(options, key);
  var ext = options.ext || '.jpg';
  var imgSrc = options.id + ext + '?quality=' + options.quality;
  imgSrc += '&width=' + options.width + '&height=' + options.height;
  imgSrc += '&hash=' + hash;
  return imgSrc;
}

function isValidHash(hash, options, key) {
  return hash === generateImageHash(options, key);
}

exports.ImageUploadApp = ImageUploadApp;
exports.ImageProcessApp = ImageProcessApp;
exports.generateImageHash = generateImageHash;
exports.generateImageThumbUrl = generateImageThumbUrl;
exports.isValidHash = isValidHash;
