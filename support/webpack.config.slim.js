
var webpack = require('webpack');
var UglifyJSPlugin = require('uglifyjs-webpack-plugin');

module.exports = {
  name: 'slim',
  entry: './lib/index.js',
  output: {
    library: 'io',
    libraryTarget: 'umd',
    filename: 'socket.io.slim.js'
  },
  externals: {
    global: glob(),
    json3: 'JSON'
  },
  devtool: 'source-map',
  plugins: [
    new webpack.NormalModuleReplacementPlugin(/debug/, process.cwd() + '/support/noop.js'),
    new UglifyJSPlugin({
      sourceMap: true,
      uglifyOptions: {
        output: {
          beautify: false
        }
      }
    })
  ],
  module: {
    loaders: [{
      test: /\.js$/,
      exclude: /(node_modules|bower_components)/,
      loader: 'babel-loader',
      query: { presets: ['es2015'] }
    }, {
      test: /\.js$/,
      include: /node_modules\/logoran-compose/,
      loader: 'babel-loader',
      query: { presets: ['es2015'] }
    }, {
      test: /\json3.js/,
      loader: 'imports?define=>false'
    }, {
      test: /\.js$/,
      loader: 'strip-loader?strip[]=debug'
    }, {
      test: /\.json$/,
      loader: 'json-loader'
    }]
  }
};

/**
 * Populates `global`.
 *
 * @api private
 */

function glob () {
  return 'typeof self !== "undefined" ? self : ' +
    'typeof window !== "undefined" ? window : ' +
    'typeof global !== "undefined" ? global : {}';
}
