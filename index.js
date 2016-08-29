// Copyright 2016 Mariano Ruiz <mrsarm@gmail.com>
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//
//        http://www.apache.org/licenses/LICENSE-2.0
//
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.

'use strict';

var request = require('request');
var ReadStream = require("fs").ReadStream;

/**
 * Wrapper class of the HTTP client module `request` that makes request
 * in an asynchronous way, returning `Promise` objects to handle the
 * responses without blocking the execution, and removes
 * boilerplate configurations on each request: base URL, time out,
 * content type format and error handling.
 * Also allows log all operations, with `cURL` format.
 */
class RequestClient {

  /**
   * @param config A string with the the base URL, or an object with the following configuration:
   * - baseUrl The base URL for all the request
   * - timeout (optional) The TTL of the request in milliseconds
   * - contentType (optional, default `json`) Content type,
   *               valid values: `json`, `form` or `formData`
   * - headers (optional) Object with default values to send as headers.
   *           Additional headers values can be added in the request
   *           call, even override these values
   * - auth (optional) HTTP Authentication options. The object must contain:
   *   - user || username
   *   - pass || password
   *   - sendImmediately (optional)
   *   - bearer (optional)
   * - encodeQuery (optional, default true) Encode query parameters
   *               replacing "unsafe" characters in the URL with the corresponding
   *                hexadecimal equivalent code (eg. "+" -> "%2B")
   * - cache (optional, default false) Ff it's set to `true`,
   *         adds cache support to GET requests
   * - debugRequest (optional) If it's set to `true`, all requests
   *                will logged with `logger` object in a `cURL` style.
   * - debugResponse (optional) If it's set to `true`, all responses
   *                 will logged with `logger` object
   * - logger (optional, by default uses the `console` object)
   *          The logger used to log requests, responses and errors
   */
  constructor(config) {
    if (typeof(config)!='string') {
      this.baseUrl = config.baseUrl;
      if (this.baseUrl[this.baseUrl.length - 1] != "/") {
        this.baseUrl += "/";
      }
      this.timeout = config.timeout;
      this.contentType = config.contentType || 'json';
      this.debugRequest = config.debugRequest || false;
      this.debugResponse = config.debugResponse || false;
      this.logger = config.logger || console;
      this.headers = config.headers || {};
      this.encodeQuery = config.encodeQuery!=undefined ? config.encodeQuery : true;
      if (config.cache) {
        this._initCache();
      }

      // HTTP Auth
      if (config.auth) {
        this.auth = config.auth;
      }

      // OAuth2
      if (config.oauth2) {
        this.oauth2 = Object.assign({}, config.oauth2);
        this.oauth2.tokenEndpoint = config.oauth2.tokenEndpoint ? config.oauth2.tokenEndpoint : "token";
        this.oauth2.grantType = config.oauth2.grantType ? config.oauth2.grantType : "client_credentials";

        var oauth2Config = {};
        oauth2Config.baseUrl = this.oauth2.baseUrl ? this.oauth2.baseUrl : this.baseUrl;
        oauth2Config.contentType = this.oauth2.contentType ? this.oauth2.contentType : "formData";
        oauth2Config.debugRequest = this.oauth2.debugRequest!=undefined ? this.oauth2.debugRequest : this.debugRequest;
        oauth2Config.debugResponse = this.oauth2.debugResponse!=undefined ? this.oauth2.debugResponse : this.debugResponse;
        oauth2Config.logger = this.oauth2.logger ? this.oauth2.logger : this.logger;
        oauth2Config.auth = this.oauth2.auth ? this.oauth2.auth : this.auth;
        this.oauth2._client = new RequestClient(oauth2Config);
      }
    } else {
      this.baseUrl = config;
    }
  }

  request(method, uri, data, headers, cacheTtl /* sec */) {
    if (this.cache && method=='GET' && cacheTtl!=undefined) {
      var self = this;
      return new Promise(function(resolve, reject) {
        var parsedUri = self._parseUri(uri);
        self.cache.get(parsedUri, function (err, value) {
          if (!err) {
            if (value!=undefined) {
              self._debugCacheResponse(uri, value);
              resolve(value);
            } else {
              // Do the request and save the result in the cache before returns (anyway returns in async way the promise)
              resolve(self._doRequest(method, uri, undefined, headers).then(function(result) {
                self.cache.set(parsedUri, result, cacheTtl,
                  (err, success) => { if (err || !success) self.logger.error('Error saving "%s" in cache. %s', parsedUri, err) });
                return result;
              }));
            }
          } else {
            reject(err);
          }
        });
      });
    } else {
      return this._doRequest(method, uri, data, headers);
    }
  }
  get(uri, headers, cacheTtl) {
    return this.request('GET', uri, undefined, headers, cacheTtl);
  }
  post(uri, data, headers) {
    return this.request('POST', uri, data, headers);
  }
  patch(uri, data, headers) {
    return this.request('PATCH', uri, data, headers);
  }
  put(uri, data, headers) {
    return this.request('PUT', uri, data, headers);
  }
  delete(uri, headers) {
    return this.request('DELETE', uri, undefined, headers);
  }

  // Delete element from local cache. The uri is the Id of the
  // response cached, and can be an string or an object like the
  // `get()` calls.
  deleteFromCache(uri) {
    if (this.cache) {
      var parsedUri = this._parseUri(uri);
      var self = this;
      this.cache.del(parsedUri, function(err, count) {
        if(err) {
          self.logger.error('Error deleting cache element "%s". %s', parsedUri, err);
        }
      });
    } else {
      // Nothing happens ...
    }
  }

  _prepareOAuth2Token() {
    var self = this;
    if (!self.tokenData) {
      return self.oauth2._client.post(self.oauth2.tokenEndpoint, {"grant_type": self.oauth2.grantType})
        .then(function (tokenData) {
          if (typeof(tokenData) == 'string') {
            tokenData = JSON.parse(tokenData);
          }
          self.tokenData = tokenData;
          return { "bearer": self.tokenData.access_token };
        });
    }
    return Promise.resolve({ "bearer": self.tokenData.access_token} );
  }

  _doRequest(method, uri, data, headers) {
    var self = this;
    return new Promise(function(resolve, reject) {
      self._prepareOptions(method, uri, headers, data).then(function(options) {
        self._debugRequest(options, uri);
        request(options, function(error, httpResponse, body) {
          if (httpResponse && httpResponse.statusCode) {
            self._debugResponse(uri, httpResponse.statusCode, body);
          }
          if (httpResponse && httpResponse.statusCode < 400) {
            resolve(self._prepareResponseBody(body));       // Successful request
          } else if (error) {
            self._handleError(error, uri, options, reject); // Fatal client or server error (unreachable server, time out...)
          } else {
            reject(self._prepareResponseBody(body));        // The server response has status error, due mostly by a wrong client request
          }
        });
      });
    });
  }

  // If the response body is a JSON -> parse it to return as a JSON object.
  _prepareResponseBody(body) {
    try {
      if (typeof body == "string" && this.contentType == 'json') body = JSON.parse(body);
    } catch (err) {}
    return body;
  }

  // Prepare the request [options](https://www.npmjs.com/package/request#requestoptions-callback)
  _prepareOptions(method, uri, headers, data) {
    var self = this;
    return new Promise(function(resolve) {
      var options = {};
      options.method = method;
      var parsedUri = self._parseUri(uri);
      if (parsedUri.indexOf("http://") == 0 || parsedUri.indexOf("https://") == 0) {
        options["url"] = parsedUri;
      } else {
        options["url"] = self.baseUrl + parsedUri;
      }
      if (headers || self.headers) {
        if (headers) {
          options["headers"] = Object.assign({}, headers, self.headers);
        } else {
          options["headers"] = Object.assign({}, self.headers);
        }
      }
      if (data) {
        if ("headers" in options && options["headers"]["Content-Type"] == "multipart/form-data") {
          options["formData"] = data;
        }
        else if ("headers" in options && options["headers"]["Content-Type"] == "application/x-www-form-urlencoded") {
          options["form"] = data;
        } else {
          options[self.contentType] = data;
        }
      }
      if (self.timeout) {
        options["timeout"] = self.timeout
      }
      if (self.auth) {
        options["auth"] = self.auth;
      }
      resolve(options);
    }).then(options => {
      if (self.oauth2) {
        return self._prepareOAuth2Token().then(auth => {
          options.auth = auth;
          return options;
        });
      } else {
        return options;
      }
    });
  }

  // If the `uri` is an object like `{ "uri": "users/{id}", "params": {"id": 1234}, "query": {"summarize": true, "info": "sales"} }`,
  // parse it as a full URI string: "users/1234?summarize=true&info=sales"
  _parseUri(uri) {
    var uriOpt = uri;
    if (typeof(uri)=='object') {
      uriOpt = Object.assign({}, uri);
      var query = [];
      if ("query" in uri && uri["query"]) {
        for (var k in uri["query"]) {
          var value = uri["query"][k];
          if (this.encodeQuery && typeof(value) == 'string') {
            value = encodeURIComponent(value);
          }
          query.push(k + "=" + value);
        }
      }
      if ("params" in uri && uri["params"]) {
        for (var k in uri["params"]) {
          uriOpt["uri"] = uriOpt["uri"].replace("{"+k+"}", uri["params"][k]);
        }
      }
      uriOpt = uriOpt["uri"];
      if (query.length>0) uriOpt += "?" + query.join("&");
    }
    return uriOpt;
  }

  // Debug request in cURL format
  _debugRequest(options, uri) {
    if (this.debugRequest) {
      var curl = options.url;
      if (curl.indexOf('&')>0 || curl.indexOf(' ')>0) {
        curl = '"' + curl + '"';
      }
      if (options.method != 'GET') {
        curl = '-X ' + options.method + ' ' + curl;
      }
      if (options.auth) {
        if (options.auth.user || options.auth.username) {
          curl += " -u ${USERNAME}:${PASSWORD}";
        } else if (options.auth.bearer) {
          curl += " -H 'Authorization: Bearer ${ACCESS_TOKEN}'";
        }
      }
      if (options[this.contentType] || options["formData"] || options["form"]) {
        var data = options[this.contentType] || options["formData"] || options["form"];
        if (options["formData"] || options["form"]) {
          for (k in data) {
            var v = data[k];
            if (v == null || v == undefined) {
              v = "";
            } else if (v instanceof ReadStream) {
              v = "@" + v.path;
            } else if (typeof(v) != 'string') {
              v = v.toString();
            }
            curl += " -F '" + k + "=" + v + "'";
          }
        } else {
          if (typeof(data) != 'string' && this.contentType == "json") {
            data = JSON.stringify(data);
          }
          curl += " -d '" + data + "'";
        }
      }
      for (var k in options["headers"]) {
        curl += " -H '" + k + ":" + options["headers"][k] + "'";
      }
      if ((!options["headers"] || !options["headers"]["Content-Type"])
            && this.contentType=="json" && options.method != 'GET' && options.method != 'DELETE'
            && data!=undefined && data!=null) {
        curl += ' -H Content-Type:application/json'
      }
      if (this.timeout) {
        curl += ' --connect-timeout ' + (this.timeout / 1000.0); // ms to sec
      }
      if (typeof(uri)!='string') {
        uri = uri["uri"];
      }
      this.logger.log("[Requesting %s]-> %s", uri, curl);
    }
  }

  // Debug response status and body
  _debugResponse(uri, status, body) {
    if (this.debugResponse) {
      if (body==undefined) {
        body = "";
      } else if (typeof(body)!='string') {
        body = JSON.stringify(body);
      }
      if (status<400) {
        this.logger.log("[Response   %s]<- Status %s - %s", typeof(uri) == 'string' ? uri : uri['uri'], status, body);
      } else {
        this.logger.error("[Response   %s]<- Status %s - %s", typeof(uri) == 'string' ? uri : uri['uri'], status, body);
      }
    }
  }

  // Debug response cache
  _debugCacheResponse(uri, body) {
    if (this.debugResponse) {
      this.logger.log("[Response   %s]<- Returning from cache", typeof(uri) == 'string' ? uri : uri['uri']);
    }
  }

  // Handle the unexpected errors
  _handleError(error, uri, options, reject) {
    if (['ETIMEDOUT','ECONNREFUSED','ENOTFOUND'].indexOf(error.code)>=0) {
      if (typeof(uri)!='string') {
        uri = uri["uri"];
      }
      this.logger.error("[Error      %s]<- Doing %s to %s. %s", uri, options.method, options.url, error);
      reject(new ConnectionError("Connection error", error));
    } else {
      reject(error);
    }
  }

  // Creates the `_cache` object that manage the cache
  // that stores the GET response
  _initCache() {
    var NodeCache = require("node-cache");
    this.cache = new NodeCache();
  }
}

function ConnectionError(message, cause) {
  Error.captureStackTrace(this, this.constructor);
  this.name = this.constructor.name;
  this.message = message;
  if (cause) {
    this.cause = cause;
  }
};

require('util').inherits(ConnectionError, Error);

module.exports = {
  RequestClient: RequestClient,
  ConnectionError: ConnectionError
};
