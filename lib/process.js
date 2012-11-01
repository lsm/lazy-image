/**
 * Native deps
 */
var Stream = require('stream');
var util = require("util");

/**
 * Third party deps
 */
var genji = require('genji');
var MongodbAsync = require('mongodb-async');
var gm = require('gm');
var IncomingForm = require('formidable').IncomingForm;
var extend = genji.extend;

// db
var connect = MongodbAsync.connect;
var Binary = MongodbAsync.mongodb.BSONPure.Binary;
var ImageModel = require('./model').ImageModel;

// web
var BaseHandler = genji.handler.BaseHandler;
var App = genji.App;

// internal deps
var ImageUploadApp = require('./upload').ImageUploadApp;

function StreamForwarder() {
  Stream.call(this);
  this.writable = true;
  this.readable = true;
}

util.inherits(StreamForwarder, Stream);

extend(StreamForwarder.prototype, {
  write: function (chunk) {
    this.emit('data', chunk, 'binary');
    return this;
  },

  end: function () {
    this.emit('end');
  }
});

var ImageProcessApp = App('ImageProcessApp', {
  init: function (options) {
    var options_ = extend({}, ImageProcessApp.defaultOptions, options);
    // mongodb-async collection object
    this.db = connect(options_.dbHost, options_.dbPort, {poolSize: options_.dbPoolSize}).db(options_.dbName);
    this.imageCollection = this.db.collection(options_.dbCollection);
    this.tmpDir = options_.tmpDir;
    this.privateKey = options_.privateKey;
    this.denyOriginal = options_.denyOriginal;
    this.watermarkPath = options_.watermarkPath;
    this.autoWatermarkOnResize = options_.autoWatermarkOnResize;
    this.minWatermarkImageWidth = options_.minWatermarkImageWidth || 460;
    var self = this;
    // ensure index
    process.nextTick(function () {
      self.imageCollection.ensureIndex({_id: 1, date: 1, filename: 1}, {background: true, unique: false});
    });
    this.defaultFields = {
      date: 1,
      filename: 1,
      type: 1,
      length: 1,
      quality: 1,
      width: 1,
      height: 1,
      url: 1,
      watermark: 1,
      created: 1
    };

    // upload app instance
    this.imageUploadApp = new ImageUploadApp(options_);
  },

  /**
   *
   * @param id Image Id
   * @param date Image date
   * @param options Image processing options, currently support:
   *  {
   *    width: 100,
   *    height: 200,
   *    quality: 80
   *  }
   */
  processImage: function (id, date, options) {
    var self = this;
    options.width && (options.width = Number(options.width));
    options.height && (options.height = Number(options.height));
    options.quality && (options.quality = Number(options.quality));
    var processedImageModel = new ImageModel(extend({
      parentId: id,
      date: date
    }, options));
    var invalidFields = processedImageModel.getInvalidFields();
    if (invalidFields) {
      self.emit('processImage', {message: 'Invalid processing options', error: invalidFields});
      return;
    }
    var query = {
      date: date,
      filename: processedImageModel.attr('filename')
    };

    var failFn = function(err) {
      self.emit('processImage', err);
    };

    // let's try to find if we have processed this image before
    this.app.imageCollection
      .findOne(query).fail(failFn)
      .then(function (imageDoc) {
        if (imageDoc) {
          // processed image found, just emit
          imageDoc.data = imageDoc.data.value();
          self.emit('processImage', null, imageDoc);
        } else {
          self.app.imageCollection.findOne({_id: id, date: date}).then(function (imageDoc) {
            if (!imageDoc) {
              self.emit('processImage', {message: 'Image not found'});
            } else {
              // set default settings from original image for processed image
              processedImageModel.attr('type', imageDoc.type);
              processedImageModel.attr('quality', imageDoc.quality);
              processedImageModel.attr('width', imageDoc.width);
              processedImageModel.attr('height', imageDoc.height);
              processedImageModel.attr('name', imageDoc.name);
              // start processing image with gm
              var buff = imageDoc.data.value();
              var stream = new StreamForwarder();
              // put stream forwarder to gm and remove profile for processed image
              var _gm = gm(stream, imageDoc.name);
              // compress is quality specified
              if (options.quality) {
                var quality = parseInt(options.quality, 10);
                if (!isNaN(quality)) {
                  // update quality
                  processedImageModel.attr('quality', quality);
                  _gm.quality(quality);
                }
              }
              // resizing
              if (options.width || options.height) {
                var width = options.width;
                var height = options.height;
                if (!width) {
                  // calculate width base on width
                  width = imageDoc.height / height * imageDoc.width;
                } else if (!height) {
                  height = imageDoc.width / width * imageDoc.height;
                }
                // update width/height
                processedImageModel.attr('width', width);
                processedImageModel.attr('height', height);
                _gm.resize(width, height);
              }

              // handle processed image stream
              _gm.stream(function (err, stdout, stderr) {
                // `stdout` is readable stream, save it to db
                if (err) {
                  self.emit('processImage', err);
                } else {
                  var e = '';
                  stderr.on('data', function (chunk) {
                    e += chunk;
                  });
                  stderr.on('end', function () {
                    if (e) {
                      self.emit('processImage', {message: e});
                    } else {
                      self.app.imageUploadApp.saveImageStream(stdout, processedImageModel.toDoc(), function (err, imageDoc) {
                        self.emit('processImage', err, imageDoc);
                      });
                    }
                  });
                }
              });

              // write data to stream forwarder
              stream.write(buff).end();
            }
          }).fail(failFn);
        }
      });
  },


  routes: {
    processImage: {url: '/process/([0-9]{8})/id/([0-9a-zA-Z]{40})\\.(?:jpg|png|gif)',
      handleFunction: function (handler, date, id, o) {
        var options = handler.params;
        var self = this;
        this.app.processImage(id, date, options, function (err, imageDoc) {
          self.emit('processImage', err, imageDoc);
        });
      }
    }
  },

  routeResults:{
    processImage:function (err, imageDoc) {
      if (err) {
        this.handler.error(500, 'process failed');
        console.error(err.stack || err.message || err);
        return;
      }
      this.handler.sendAsFile(imageDoc.data, {
        type: imageDoc.type,
        length: imageDoc.length,
        etag: imageDoc._id
      });
    }
  }
}, {
  defaultOptions: {
    dbName: 'lazy_image_test',
    dbHost: '127.0.0.1',
    dbPort: 27017,
    dbCollection: 'images',
    dbPoolSize: 2
  }
});

exports.ImageProcessApp = ImageProcessApp;