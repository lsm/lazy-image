var genji = require('genji').short();
var processer;
var ImageProcesser = require('./processer').ImageProcesser;
var connect = require('mongodb-async').connect;

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

  db.open().and(function (defer, db) {
    processer = new ImageProcesser(db, options_);
  });

  // attach middleware "conditional-get"
  genji.use('conditional-get');

  // create the http endpoint for processing and getting images
  var app = genji.app();
  // process an image from url
  app.get('^/process', processImage);

  // get an existing image
  app.get('^/image/([0-9a-zA-Z]{40})\\.(jpg|png|gif)$', getImage);
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
  processer.dbCollection.findOne(queryDoc)
    .then(
    function (imageDoc) {
      callback(null, imageDoc);
    }).fail(callback);
}

function getImage(handler, filename) {
  _getImage(filename, function (err, imageDoc) {
    if (err || !imageDoc) {
      handler.error(404, 'Image not found');
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
  this.options = genji.extend({
    exts:['.png', '.jpg', '.jpeg'],
    maxFieldsSize:8388608 // 8MB
  }, defaultDBOptions, options);
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
    this.parseRequest(request, function (fields, files) {
      if (Array.isArray(files)) {
        var filePath = files[0].path;
        processer.saveImageFileAndRemove(filePath, imageDoc || {}).and(
          function (resultImageDoc) {
            callback(null, resultImageDoc);
          }).fail(callback);
      } else {
        callback('Can not parse file info from request.');
      }
    });
  }
};

exports.ImageUploader = ImageUploader;