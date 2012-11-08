/**
 * Native deps
 */
var Stream = require('stream');
var fs = require('fs');
var Path = require('path');

/**
 * Third party deps
 */
var genji = require('genji');
var MongodbAsync = require('mongodb-async');
var gm = require('gm');
var IncomingForm = require('formidable').IncomingForm;

// web
var BaseHandler = genji.handler.BaseHandler;
var App = genji.App;

// db
var connect = MongodbAsync.connect;
var Binary = MongodbAsync.mongodb.BSONPure.Binary;
var ImageModel = require('./model').ImageModel;

var readFile = genji.defer(fs.readFile, fs);
var sha1 = genji.crypto.sha1;
var extend = genji.extend;


var ImageUploadApp = App('ImageUploadApp', {
  init:function (options) {
    var options_ = extend({}, ImageUploadApp.defaultOptions, options);
    this.db = options_.db || connect(options_.dbHost, options_.dbPort, {poolSize:options_.dbPoolSize}).db(options_.dbName, {});
    this.imageCollection = options.imageCollection || this.db.collection(options_.dbCollection);

    // ensure index
    var self = this;
    process.nextTick(function () {
      self.imageCollection.ensureIndex({_id: 1, date: 1}, {background: true, unique: false});
    });

    // upload options
    this.exts = options_.exts || ['.png', '.jpg', '.jpeg', '.gif'];
    this.maxFieldsSize = options_.maxFieldsSize || options_.maxImageSize || 12582912; // 12MB
    this.maxImageSize = this.maxFieldsSize;
  },

  setAllowedExts:function (exts) {
    this.app.exts = exts;
    return this.app;
  },

  setMaxImageSize:function (size) {
    this.app.maxFieldsSize = size;
    return this.app;
  },

  isAllowedExt:function (filename) {
    return this.app.exts.indexOf(Path.extname(filename.toLowerCase())) > -1;
  },

  formatToMime: function (format) {
    var f = format.toLowerCase();
    switch(f) {
      case 'jpeg':
      case 'jpg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'png':
        return 'image/png';
      default:
        return 'application/octet-stream';
    }
  },

  parseRequest:function (request) {
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
        if (self.app.isAllowedExt(file.name)) {
          file.field = field;
          files.push(file);
        } else {
          self.emit('parseRequest', 'Invalid file extention: ' + Path.extname(file.name));
        }
      })
      .on('end', function () {
        self.emit('parseRequest', null, fields, files.length > 0 ? files : null);
      })
      .on('error', function (err) {
        self.emit('parseRequest', err);
      });
    form.parse(request);
  },


  /**
   * Save an image doc into database
   * @param {Object} imageDoc
   */
  saveImageDoc:function (imageDoc) {
    if (!imageDoc.data instanceof Buffer) {
      this.emit('saveImageDoc', {message: 'Image data is not instance of Buffer'});
      return;
    }
    var meta = imageDoc.meta;
    if (!meta || !meta.size) {
      this.emit('saveImageDoc', {message: 'Missing meta/size info of image doc'});
      return;
    }
    delete imageDoc.meta; // meta is contained in image, no need to save to db.

    var self = this;
    imageDoc.width = meta.size.width;
    imageDoc.height = meta.size.height;
    imageDoc.type = this.app.formatToMime(meta.format);
    var imageModel = new ImageModel(imageDoc);
    var invalidFields = imageModel.getInvalidFields();
    if (invalidFields) {
      this.emit('saveImageDoc', {message: 'Invalid image doc fields', invalidFields: invalidFields});
      return;
    }

    this.app.imageCollection.findOne({_id: imageModel.attr('id')})
      .then(function (existedImage) {
        if (existedImage) {
          existedImage.data = existedImage.data.value();
          self.emit('saveImageDoc', null, existedImage);
        } else {
          var imageDoc_ = imageModel.toDoc();
          imageDoc_.data = new Binary(imageDoc_.data);
          imageDoc_.length = imageDoc_.data.length();
          self.app.imageCollection
            .insert(imageDoc_, {safe: true})
            .callback(function (err, inserted) {
              if (err) {
                self.emit('saveImageDoc', err);
              } else if (Array.isArray(inserted) && inserted.length === 1 && inserted[0]) {
                // convert bson binary to buffer
                inserted[0].data = inserted[0].data.value();
                self.emit('saveImageDoc', null, inserted[0]);
              } else {
                self.emit('saveImageDoc', {message: 'MongoDB: Failed to save image doc.', error: {inserted: inserted}});
              }
            });
        }
      }).fail(function (err) {
        self.emit('saveImageDoc', err);
      });
  },

  /**
   * Read file from `filePath` and save to database
   *
   * @param {String} filePath
   * @return {Deferrable}
   */
  saveImageFile:function (filePath, imageDoc, unlink) {
    var self = this;
    imageDoc = imageDoc || {};
    readFile(filePath)
      .and(function (defer, data) {
        gm(filePath).identify(function (err, info) {
          if (err) {
            defer.error(err);
            return;
          }
          imageDoc.meta = info;
          imageDoc.data = data;
          self.app.saveImageDoc(imageDoc, function (err, doc) {
            err ? defer.error(err) : defer.next(doc);
          });
        });
      }).and(function (defer, imageDoc) {
        if (unlink === true || unlink === undefined) {
          fs.unlink(filePath, function (err) {
            err ? defer.error(err) : defer.next(imageDoc);
          });
        } else {
          return true;
        }
      }).and(function (defer, imageDoc) {
        self.emit('saveImageFile', null, imageDoc);
      }).fail(function (err) {
        self.emit('saveImageFile', err);
        console.log(err.stack || err.message || err);
      });
  },

  saveImageStream: function (stream, imageDoc) {
    if (stream instanceof Stream) {
      var self = this;
      gm(stream).identify({bufferStream: true}, function (err, info) {
        if (err) {
          self.emit('saveImageStream', err);
          return;
        }

        imageDoc.meta = info;
        var chunks = [];
        var length = 0;

        stream.on('data', function (chunk) {
          chunks.push(chunk);
          length += chunk.length;
          if (length > self.app.maxImageSize) {
            // max image size exceeded, destroy the stream
            stream.destroy();
            self.emit('saveImageStream', {message: 'Image too large'});
          }
        });

        stream.on('end', function () {
          imageDoc.data = Buffer.concat(chunks, length);
          self.app.saveImageDoc(imageDoc, function (err, doc) {
            self.emit('saveImageStream', err ? err : null, doc);
          });
        });
        this.buffer.resume();
      });
    } else {
      this.emit('saveImageSream', stream instanceof Stream ? 'No image stream provided' : 'Invalid image length');
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

    uploadImageStream:{method:'post', url:'/upload/image/stream', handleFunction:function (handler) {
      var request = handler.context.request;
      var len = Number(request.headers['content-length']);
      if (isNaN(len)) {
        this.emit('saveImageStream', "header has no content length");
      } else {
        var self = this;
        var name = request.headers['x-filename'];
        this.app.saveImageStream(request, {length: len, name: name}, function (err, doc) {
          if (err) {
            self.emit('saveImageStream', err);
          } else {
            self.emit('saveImageStream', null, doc);
          }
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
      delete imageDoc.data;
      this.handler.sendJSON(imageDoc);
    },

    saveImageStream:function (err, imageDoc) {
      if (err) {
        this.handler.error(500, 'upload failed');
        console.error(err.stack || err);
        return;
      }
      delete imageDoc.data;
      this.handler.sendJSON(imageDoc);
    }
  }

}, {
  defaultOptions:{
    dbName:'lazy_image_test',
    dbHost:'127.0.0.1',
    dbPort:27017,
    dbCollection:'images',
    dbPoolSize:2
  }
});

exports.ImageUploadApp = ImageUploadApp;