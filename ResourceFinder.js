'use strict';

let isGetorDelete = new RegExp('(get|delete)', 'i');
let braceRegex = new RegExp('\{(.*?)\}', 'gi');

// TODO: Put this in a service
function parseUri(uri) {
    var matches = [];
    var curr = 0;
    var match;

    braceRegex.lastIndex = 0;
    while ((match = braceRegex.exec(uri)) != null) {
        matches.push({
            key: null,
            value: uri.substring(curr,braceRegex.lastIndex - match[0].length)
        });

        matches.push({
            key: match[1],
            value: match[0]
        });

        curr = braceRegex.lastIndex;
    }

    if (curr < uri.length) {
        matches.push({
            key: '',
            value: uri.substring(curr, uri.length)
        });
    }

    return matches;
}

// TODO: Put this in a service
function expandUri(template, params) {
    var uri = '';
    for(var i = 0; i < template.length; i++) {
        var key = template[i].key;
        var val = typeof params[key] !== 'undefined' ? params[key] : template[i].value;
        uri += val;
    }
    return uri;
}

// TODO: Put this in a service
function parseSirenEntity(entity, isSubentity, basePath) {
    isSubentity = isSubentity || false;

    if (isSubentity && typeof (entity.href) !== "undefined" && entity.href) {
        return null;
    } else {
        var classes = entity.Class || [];

        var isList = classes.length > 0
            ? classes[classes.length - 1] == "list"
            : false;

        var data = isList ? [] : {};

        var props = entity.Properties || {};
        for (var prop in props) {
            data[prop] = props[prop];
        }

        var children = entity.Children || [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            var index = isList ? i : child.Rel[0].replace(basePath, "");
            data[index] = parseSirenEntity(child, true);
        }

        return data;
    }
}

// type Finder = HttpContext -> HttpRequest -> HyperMediaDoc
function Finder(fn, req) {
    var self = this;
    self.req = req;
    //self.parseDoc = parseDoc;
   // self.basePath = basePath;
    self.doc = null; // the document that this Finder object represents.
    self.includes = [];
    self.waitingStack = []; // a buffer queue to prevent multiple simultaneous requests.

    // Wrap the run function to ensure that it's only ever resolved once. This prevents unnecessary http requests. If the request needs to be
    // done a second time, the user should create a new Finder.
    self.run = function (callback) {
        if (self.doc) {
            // document has already been fetched. Just return it to the callback;
            callback(self.doc);
        } else {
            // enqueue this request
            self.waitingStack.unshift(callback);

            // if document hasn't been fetched yet, get the document and then pass it to all the callbacks in the waiting queue.
            if (self.waitingStack.length === 1) {
                // get the document.
                console.log('running: ')
                fn.call(self, function (doc) {
                    self.doc = doc;
                    // got the document. Now give it to all who are waiting or it.
                    while (self.waitingStack.length > 0) {
                        var callback = self.waitingStack.pop();
                        callback(doc);
                    }
                });
            }
        }
    };
}

// monadic bind: used for chaining Finders. Threads the result of each http request through the chain.
Finder.bind = function(finder, fn) {
    return new Finder(function (callback) {
        finder.run(function (doc) {
            fn(doc).run(callback);
        });
    }, finder.req);
};

Finder.prototype = {
    include: function (includes) {
        includes = includes || [];
        for (var i in includes) {
            this.includes.push(includes[i]);
        }
        return this;
    },

    // A function that follows a link to a sub-entity or a document based on a "rel" attribute.
    // If the sub-entity is embedded in the current document, just return it without doing an http request.
    follow: function (rel) {
        var self = this;
        return Finder.bind(this, function (doc) {
            var uri = null;

            var links = doc.links || {};
            if (typeof(links[rel]) !== 'undefined') {
              uri = links[rel];
            } else {
              let children = doc.children || [];
              // search through subentities
              for (var i = 0; i < children.length; i++) {
                  var child = children[i];
                  if (child.rel === rel) {
                      var dataExists = typeof(child.data) !== 'undefined' && child.data !== null;
                      if (dataExists) {
                        // the subentity is available in memory. Return the resource
                        return new Finder(function (callback) {
                          callback(child);
                        });
                      } else if (child.links.self) {
                        // this is a subentity link. Follow it.
                        uri = child.links.self;
                        break;
                      } else {
                          // error
                      }
                  }
              }
            }

            return new Finder(function (callback) {
                var config = {
                    url: uri,
                    method: 'get',
                    includes: this.includes,
                    headers: { 'Accept': 'application/vnd.siren+json' }
                };

                // Send a request for the sub-entity/link.
                this.req(config, callback);
            }, self.req);
        });
    },

    // A function that post a form/action on the document. Used for RPC style calls.
    do: function (actionName, params, onprogress) {
        return Finder.bind(this, function (doc) {
            // find the action based on the actionName param.
            var action = null;
            for (var i = 0; i < doc.actions.length; i++) {
                if (doc.actions[i].Name === actionName) {
                    action = doc.actions[i];
                    break;
                }
            }

            // Enumerate the fields from the form and sets the value from the supplied "params". If the param isn't
            // available, then use the field's default value.
            var actionParams = {};
            var fileParams = {};
            for (var fieldName in action.fields) {
                var field = action.fields[fieldName];
                if (field.type == 2) {
                    fileParams[fieldName] = typeof params[fieldName] !== 'undefined' ? params[fieldName] : field.value;
                } else {
                    actionParams[fieldName] = typeof params[fieldName] !== 'undefined' ? params[fieldName] : field.value;
                }
            }

            // Parse the form action uri, which may contain a template.
            var template = parseUri(action.href);
            // Generate the form action uri from the template, substituting the actionParams for the template placeholders values.
            var uri = expandUri(template, actionParams);

            // Erase any actionParams that were present in the uri template. This ensures they're not posted twice.
            for (var i = 0; i < template.length; i++) {
                var key = template[i].key;
                if (key) {
                    delete actionParams[key];
                }
            }

            return new Finder(function (callback) {
                var config = {
                    url: uri,
                    method: action.method.method,
                    headers: { 'Accept': 'application/vnd.siren+json' },
                    files: fileParams
                };

                // used to determine if there are no actionParams.
                var hasProps = false;
                for (var prop in actionParams) {
                    hasProps = true;
                    break;
                }

                // Set the config data/params property depending on whether this is a get/delete or a post/put.
                config[isGetorDelete.test(config.method) ? "params" : "data"] = hasProps ? actionParams : undefined;

                hasFiles = false;
                for (var prop in config.files) {
                    hasFiles = true;
                    break;
                }

                if (hasFiles) {
                    file.httpMultipart(config, onprogress).then(callback, function (e) {
                        // something nasty happened;
                    });
                } else {
                    http(config).success(callback);
                }
            });
        });
    },

    insert: function (params) { return this.do('insert', params); },

    get: function (params) { return this.do('get', params); },

    update: function (params) { return this.do('update', params); },

    delete: function (params) { return this.do('delete', params); },

    map: function (mapFn) {
        return bind(this, function (doc) {
            var result = mapFn(doc.data);
            return new Finder(function (callback) {
                callback({
                    rel: doc.rel,
                    links: doc.links,
                    data: result,
                    children: doc.children
                });
            });
        });
    },

    // Pull the data out of the document and give it back to the user
    resolve: function (callback) {
        var self = this;
        self.run(function (doc) {
            //var val = parseRsRepresentation(doc);
            if (callback) {
                var val = callback(doc);
            }
            //self.deferred.resolve(val);
        });

        // send back this Finder just incase users want to hold onto it.
        return self;
    },

    // Pull the data out of the document and give it back to the user
    resolveData: function (callback) {
        return this.resolve(function (doc){
            callback(doc.data);
        });
    },

    // Pull the properties out of the document and give it back to the user
    resolveProps: function (callback) {
        return this.resolve(function (doc){
            callback(doc.props);
        });
    },

    // Pull the properties out of the document and give it back to the user
    resolveChildren: function (callback) {
        return this.resolve(function (doc){
            callback(doc.children);
        });
    }

    //then: function(callback,errback) {
    //    return this.deferred.promise.then(callback, errback);
    //}
};

exports.HypermediaClient = function(req) {
    return {
        // Gets dereferences a uri and wraps the resource in a Finder
        from: function (uri) {
            return new Finder(function (callback) {
                var config = {
                    url: uri,
                    method: "get",
                    includes: this.includes,
                    headers: { 'Accept': 'application/vnd.siren+json' },
                };
                this.req(config, callback);
            }, req);
        },
        follow: function (rel) {
            return this.from(apiRoot).follow(rel);
        }
  };
}
