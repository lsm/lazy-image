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
var model = require('./../lib/model');
var ImageModel = model.ImageModel;
var fs = require('fs');





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
      var imageModel = new ImageModel(options);
      imageId = imageModel.attr('filename');
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
    processer
      .imageCollection.findOne(queryDoc).then(function (imageDoc) {
      if (imageDoc) {
        imageDoc.data = imageDoc.data.value();
        self.emit('getImageById', null, imageDoc);
      } else {
        if (lazyProcess) {
          // find the original image and resize
          processer.imageCollection.findOne({_id:origFilename}, {data: 0}).and(
            function (defer, imageDoc) {
              if (!imageDoc) {
                self.emit('getImageById', 'Image not found');
              } else {
                var imageToResize = {
                  _id: origFilename,
                  filename: imageId,
                  date: imageDoc.date
                };
                processer.resize(imageToResize, options).then(defer.next).fail(defer.error);
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
  var hash = sha1([options.id, options.width, options.height, options.quality, options.watermark, key].join('_'));
  return hash;
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
exports.getClientCodeString = function () {
  var str = '';
  str += generateImageHash.toString();
  str += '\n' + generateImageThumbUrl.toString();
  return str;
};
