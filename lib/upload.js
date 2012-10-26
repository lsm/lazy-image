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
    var db = connect(options_.dbHost, options_.dbPort, {poolSize:options_.dbPoolSize}).db(options_.dbName, {});
    this.imageCollection = db.collection(options_.dbCollection);
    db.open()
      .fail(function (err) {
        console.trace('Can not connect to mongodb with options: ');
        console.error(options_);
        throw err;
      });

    // upload options
    this.exts = options_.exts || ['.png', '.jpg', '.jpeg', '.gif'];
    this.maxFieldsSize = options_.maxFieldsSize || 12582912; // 12MB
  },

  setAllowedExts:function (exts) {
    this.app.exts = exts;
    return this.app;
  },

  setMaxFieldsSize:function (size) {
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
    delete imageDoc.meta; // meta is contained in image, no need to save to db.
    if (!meta || !meta.size) {
      this.emit('saveImageDoc', {message: 'Missing meta/size info of image doc'});
      return;
    }

    var self = this;
    imageDoc.width = meta.size.width;
    imageDoc.height = meta.size.height;
    imageDoc.type = this.app.formatToMime(meta.format);
    var id = sha1(imageDoc.data);

    this.app.imageCollection.findOne({_id: id}, {_id: 1, filename: 1})
      .then(function (existedImage) {
        if (existedImage) {
          self.emit('saveImageDoc', null, existedImage);
        } else {
          var imageModel = new ImageModel(imageDoc);
          if (imageModel.isValid()) {
            var imageDoc_ = imageModel.toDoc();
            imageDoc_.data = new Binary(imageDoc_.data);
            imageDoc_.length = imageDoc_.data.length();
            self.app.imageCollection
              .insert(imageDoc_, {safe: true})
              .callback(function (err, inserted) {
                if (err) {
                  self.emit('saveImageDoc', err);
                } else if (Array.isArray(inserted) && inserted.length === 1 && inserted[0]) {
                  self.emit('saveImageDoc', null, inserted[0]);
                } else {
                  self.emit('saveImageDoc', {message: 'MongoDB: Failed to save image doc.', error: {inserted: inserted}});
                }
              });
          } else {
            self.emit('saveImageDoc', {error: {invalidFields: imageModel.getInvalidFields()}, message: 'Invalid image doc'});
          }
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
        delete imageDoc.data;
        self.emit('saveImageFile', null, imageDoc);
      }).fail(function (err) {
        self.emit('saveImageFile', err);
        console.log(err.stack || err.message || err);
      });
  },

  saveImageStream: function (stream, imageDoc) {
    if (stream instanceof Stream && !isNaN(imageDoc.length)) {
      var self = this;
      gm(stream).identify({bufferStream: true}, function (err, info) {
        if (err) {
          callback(err);
          return;
        }

        imageDoc.meta = info;

        var buffer = new Buffer(imageDoc.length);
        var offset = 0;

        stream.on('data', function (chunk) {
          chunk.copy(buffer, offset, 0, chunk.length);
          offset += chunk.length;
        });

        stream.on('end', function () {
          imageDoc.data = buffer;
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
            delete doc.data;
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
      this.handler.sendJSON(imageDoc);
    },

    saveImageStream:function (err, imageDoc) {
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
    dbPoolSize:2
  }
});

exports.ImageUploadApp = ImageUploadApp;