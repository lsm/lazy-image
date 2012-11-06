var genji = require('genji');
var Model = genji.Model;
var dateformat = require('dateformat');
var sha1 = genji.crypto.sha1;

var ImageModel = Model('ImageModel', {
  fields: {
    // '441547af33d49c4f37461fa87a5bb502b40687f2', sha1 hash of the file content, first sharding key
    // high cardinality + write scaling
    id: 'string',
    // '20120618' image creation date string, second sharding key
    // query isolation
    date: 'string',
    // generated filename
    filename: 'string',
    // original filename
    name: 'string',
    // image blob
    data:function (value) {
      return !Buffer.isBuffer(value);
    },
    // mime type
    type: 'string',
    // binary length of image
    length: 'number',
    // image quality
    quality: 'number',
    // image width in px
    width: 'number',
    // image height in px
    height: 'number',
    // url of oringinal image (optional)
    url: 'string',
    // '1' if image has watermark, else omit this field, optional
    watermark: 'string',
    // date created
    created: 'date'
  },

  init: function (data) {
    !data.date && this.attr('date', dateformat(new Date, "yyyymmdd"));
    !data.created && this.attr('created', new Date);
    if (data.parentId && data.filename) {
      // processed image, filename should be the id
      this.attr('id', data.filename);
    }
    !data.filename && this.attr('filename', this.attr('filename'));
  },

  setData:function (value) {
    if (!this.attr('id')) {
      this.attr('id', sha1(value));
    }
    return value;
  },

  getFilename:function () {
    var hash = this.attr(['width', 'height', 'watermark', 'quality']);
    hash.id = this.attr('parentId') || this.attr('id');
    var hashStr = '';
    Object.keys(hash).sort().forEach(function (key) {
      hash[key] && (hashStr += key + ':' + hash[key]);
    });
    return sha1(hashStr);
  }
}, {
  getThumbHash: function (options, key) {
    var keys = ['id', 'width', 'height', 'watermark', 'quality'];
    var hashStr = '';
    keys.sort().forEach(function (k) {
      options[k] && (hashStr += k + ':' + options[k]);
    });
    hashStr += 'key:' + key;
    return sha1(hashStr);
  },

  getThumbUrl: function (options, key) {
    var thumbHash = ImageModel.getThumbHash(options, key);
    var ext = options.ext || '.jpg';
    var keys = ['width', 'height', 'watermark', 'quality'];
    var url = options.id + ext + '?';
    keys.sort().forEach(function (k) {
      options[k] && (url += k + '=' + options[k] + '&');
    });
    url += 'hash=' + thumbHash;
  }
});

exports.ImageModel = ImageModel;