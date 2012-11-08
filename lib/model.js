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
    // id of the original image, use the generate image id without pulling the data
    parentId: 'string',
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
    if (!data.id && !data.data && !data.parentId) {
      throw new Error('One of the 3 attributes [id, data, parentId] must be provided');
    }
    !data.id && this.attr('id', this.attr('id'));
  },

  getId:function (value) {
    if (value) {
      return value;
    }
    var hash = this.attr(['width', 'height', 'watermark', 'quality']);
    hash.id = this.attr('parentId') || sha1(this.attr('data'));
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