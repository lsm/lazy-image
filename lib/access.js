/**
 * Third party deps
 */
var genji = require('genji');
var MongodbAsync = require('mongodb-async');
var App = genji.App;

// db
var connect = MongodbAsync.connect;
var extend = genji.extend;


var ImageAccessApp = App('ImageAccessApp', {

  init:function (options) {
    var options_ = extend({}, ImageAccessApp.defaultOptions, options);
    var db = options_.db || connect(options_.dbHost, options_.dbPort, {poolSize:options_.dbPoolSize}).db(options_.dbName, {});
    this.imageCollection = options_.imageCollection || db.collection(options_.dbCollection);
  },

  getImageDoc: function (query) {
    var self = this;
    this.app.imageCollection.findOne(query)
      .then(function (imageDoc) {
        if (imageDoc) {
          imageDoc.data = imageDoc.data.value();
          self.emit('getImageDoc', null, imageDoc);
        } else {
          self.emit('getImageDoc', {message: 'Image not found.', query: query});
        }
      }).fail(function (err) {
        self.emit('getImageDoc', err);
        console.log(err.stack || err.message || err);
      });
  },

  getImageByDateId:function (date, imageId) {
    var self = this;
    var query = {date: date, _id: imageId};
    this.app.getImageDoc(query, function (err, imageDoc) {
      if (imageDoc) {
        self.emit('getImageByDateId', null, imageDoc);
      } else {
        self.emit('getImageByDateId', err || {message: 'Image ' + imageId + ' not found.'});
      }
    });
  },

  getImageByFilename: function (filename) {
    var self = this;
    this.app.getImageDoc({filename: filename}, function (err, imageDoc) {
      if (imageDoc) {
        self.emit('getImageByFilename', null, imageDoc);
      } else {
        self.emit('getImageByFilename', err || {message: 'Image ' + filename + ' not found.'});
      }
    });
  },

  routes:{
    getImageByDateId:{method:'get', url:'/([0-9]{8})/id/([0-9a-zA-Z]{40})\\.(?:jpg|png|gif)$'},
    getImageByFilename:{method:'get', url:'/([0-9a-zA-Z]{40})\\.(?:jpg|png|gif)$'},
    notFound:{method: 'notFound', url: '^/*', handleFunction:function (handler) {
      handler.error(404, 'invalid endpoint');
      console.log('Invalid endpoint: ' + handler.context.request.url);
    }}
  },

  routeResults:{
    getImageByDateId:function (err, imageDoc) {
      if (err || !imageDoc) {
        this.handler.error(404, 'Image not found');
        console.error(err.stack || err);
        return;
      }
      this.handler.sendAsFile(imageDoc.data, {
        type: imageDoc.type,
        length: imageDoc.length,
        etag: imageDoc._id
      });
    },

    getImageByFilename: function (err, imageDoc) {
      if (err || !imageDoc) {
        this.handler.error(404, 'Image not found');
        console.error(err.stack || err);
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
  defaultOptions:{
    dbName:'lazy_image_test',
    dbHost:'127.0.0.1',
    dbPort:27017,
    dbCollection:'images',
    dbPoolSize:2
  }
});

exports.ImageAccessApp = ImageAccessApp;