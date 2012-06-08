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
    return this.exts.indexOf(Path.extname(filename)) > -1;
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

  saveImageFile:function (filePath, imageDoc) {
    this.app.processer
      .saveImageFileAndRemove(filePath, imageDoc)
      .and(function (defer, resultImageDoc) {
        delete resultImageDoc.data;
        callback(null, resultImageDoc);
        self.emit('saveImageFile', null, resultImageDoc);
      }).fail(function (err) {
        self.emit('saveImageFile', err);
      });
  },

  saveImageBlob:function (blob, imageDoc) {
    var self = this;
    this.app.processer.saveImageData(function (err, imageDoc) {
      self.emit('saveImageBlob', err, imageDoc);
    }, blob, imageDoc);
  },

  routes: {
    uploadImageFile:{method: 'post', url:'/upload/image/file', handleFunction:function (handler) {
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
    }},
    uploadImageBlob:{method:'post', url:'/upload/image/blob', handleFunction:function (handler) {
      var request = handler.context.request;
      var len = Number(request.headers['content-length']);
      if (isNaN(len)) {
        this.emit('saveImageBlob', "header has no content length");
      } else {
        var buff = new Buffer(len);
        var offset = 0;
        var self = this;
        request.on('data', function (chunk) {
          if (Buffer.isBuffer(chunk)) {
            chunk.copy(buff, offset, 0, chunk.length);
            offset += chunk.length;
          } else {
            self.emit('saveImageBlob', "Only Buffer is allowed");
            request.connection.destroy();
          }
        });
        request.on('end', function () {
          var imageDoc = {
            type:request.headers['content-type']
          };
          self.app.saveImageBlob.call(self, buff, imageDoc);
        });
      }
    }}
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