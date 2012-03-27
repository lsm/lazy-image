var genji = require('genji').short();
var Path = require('path');
var processer;
var ImageProcesser = require('./processer').ImageProcesser;
var connect = require('mongodb-async').connect;
var crypto = genji.require('crypto');
var sha1 = crypto.sha1;

var defaultDBOptions = {
  dbName:'lazy_image_test',
  dbHost:'127.0.0.1',
  dbPort:27017,
  dbCollection:'images',
  dbPoolSize:10
};

/**
 * http server
 */
exports.createImageServer = function (options, uploadURL) {
  var options_ = genji.extend({}, defaultDBOptions, options);
  var db = connect(options_.dbHost, options_.dbPort, {poolSize:options_.dbPoolSize}).db(options_.dbName, {});

  processer = new ImageProcesser(options_, db);

  db.open()
    .fail(function (err) {
      console.trace('Can not connect to mongodb with options: ');
      console.error(options_);
      throw err;
    });

  // attach middleware "conditional-get"
  genji.use('conditional-get');

  // create the http endpoint for processing and getting images
  var app = genji.app();
  // process an image from url
  app.get('^/process', processImage);

  // get an existing image
  app.get('^/image/([0-9a-zA-Z]{40})\\.(jpg|png|gif)', getImage);
  app.notFound('.*', function (handler) {
    handler.error(404, 'invalid end point');
    console.error(this.request.url);
  });

  if (uploadURL) {
    var uploader = new ImageUploader(options);
    app.post('^' + uploadURL + '$', function (handler) {
      uploader.saveImage(this.request, {}, function (err, imageDoc) {
        var result = err ? {error:'Failed to upload image'} : imageDoc;
        handler.sendJSON(result);
        err && console.error(err.stack || err);
      });
    });
  }

  // create a http server
  var server = genji.createServer();
  return server;
};


/**
 * params:
 *  url, url of image
 *  width,
 *  height,
 *
 *
 *
 */
function processImage(handler) {
  var params = handler.params;
  var url = params.url;
  var deferred = processer.saveImageFromUrl(url);
  var result = [];
  var originalDoc;
  deferred.and(
    function (defer, imageDoc) {
      delete imageDoc.data;
      originalDoc = imageDoc;
      if (params.noLossless) {
        handler.sendJSON([imageDoc]);
        return true;
      } else {
        //lossless compress
        result.push(imageDoc);
        processer.compress(imageDoc, 100, defer);
      }
    },
    function (defer, compressedDoc) {
      if (!params.noLossless) {
        result.push(compressedDoc);
      }
      if (params.width && params.height) {
        processer.resize(originalDoc, params, defer);
      } else {
        handler.sendJSON(result);
      }
    },
    function (defer, resizedDoc) {
      result.push(resizedDoc);
      handler.sendJSON(result);
    })
    .fail(function (err) {
      handler.error(500, 'Image processing error');
      console.error(err.stack || err);
    });
}

function _getImage(filename, callback) {
  var queryDoc = filename.length === 40 ? {_id:filename} : {filename:filename};
  processer.imageCollection.findOne(queryDoc)
    .then(
    function (imageDoc) {
      callback(null, imageDoc);
    }).fail(callback);
}

function genImageHash(id, width, height, quality, key) {
  return sha1([id, width, height, quality, key].join('_'));
}

function getImage(handler, filename) {
  var params = handler.params;
  var lazyProcess = false;
  var origFilename = filename;
  if (filename.length === 40 && params.hash && params.width && params.height) {
    params.quality = params.quality || 100;
    filename = [filename, params.quality, params.width + 'x' + params.height].join('_');
    lazyProcess = params.hash === genImageHash(origFilename, params.width, params.height, params.quality, processer.privateKey);
  }
  _getImage(filename, function (err, imageDoc) {
    if (err) {
      handler.error(404, 'Image not found');
    } else if (!imageDoc) {
      if (lazyProcess) {
        // find the original image and resize
        processer.imageCollection.findOne({_id:origFilename}).and(
          function (defer, imageDoc) {
            if (!imageDoc) {
              handler.error(404, 'Image not found');
            } else {
              processer.resize(imageDoc, params, defer);
            }
          }).then(function (resizedDoc) {
            _getImage(resizedDoc._id, function (err, imageDoc) {
              if (err || !imageDoc) {
                handler.error(404, 'Image not found');
              } else {
                var headers = {type:imageDoc.type};
                handler.sendAsFile(imageDoc.data.value(), headers);
              }
            });
          })
          .fail(function (err) {
            handler.error(404, 'Image not found');
            console.error(err.stack || err);
          });
      } else {
        handler.error(404, 'Image not found');
      }
    } else {
      var headers = {type:imageDoc.type};
      handler.sendAsFile(imageDoc.data.value(), headers);
    }
  });
}

/**
 *
 * http upload api
 *
 */
var formidable = require('formidable');

function ImageUploader(options) {
  var options_ = genji.extend({}, defaultDBOptions, options);
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
}

ImageUploader.prototype = {
  setAllowedExts:function (exts) {
    this.exts = exts;
    return this;
  },

  setMaxFieldsSize:function (size) {
    this.maxFieldsSize = size;
    return this;
  },

  isAllowedExt:function (filename) {
    return this.exts.indexOf(Path.extname(filename)) > -1;
  },

  parseRequest:function (request, callback) {
    var form = new formidable.IncomingForm(),
      files = [], fields = {}, self = this;
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
          console.log('file extention %s not allowed', Path.extname(file.name));
        }
      })
      .on('end', function () {
        if (callback) {
          callback(null, fields, files.length > 0 ? files : null);
        } else {
          self.emit('end', fields, files.length > 0 ? files : null);
        }
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

  saveImage:function (request, imageDoc, callback) {
    var self = this;
    this.parseRequest(request, function (error, fields, files) {
      if (error || !Array.isArray(files)) {
        callback('Can not parse file info from request.');
        console.error(error.stack || error);
      } else {
        var file = files[0];
        imageDoc = imageDoc || {};
        imageDoc.type = file.type;
        self.processer.saveImageFileAndRemove(file.path, imageDoc).and(
          function (defer, resultImageDoc) {
            delete resultImageDoc.data;
            callback(null, resultImageDoc);
          }).fail(callback);
      }
    });
  }
};

exports.ImageUploader = ImageUploader;