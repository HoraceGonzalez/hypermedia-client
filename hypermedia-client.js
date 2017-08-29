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

function HypermediaQuery(fn, req) {
    var self = this;
    self.req = req;
    self.doc = null; // the document that this HypermediaQuery object represents.
    self.includes = [];
    self.waitingStack = []; // a buffer queue to prevent multiple simultaneous requests.

    // Wrap the run function to ensure that it's only ever resolved once. This prevents unnecessary http requests. If the request needs to be
    // done a second time, the user should create a new HypermediaQuery.
    self.run = function (onError,onSuccess) {
        if (self.doc) {
            // document has already been fetched. Just return it to the callback;
            onSuccess(self.doc);
        } else {
            // enqueue this request
            self.waitingStack.unshift(onSuccess);

            // if document hasn't been fetched yet, get the document and then pass it to all the callbacks in the waiting queue.
            if (self.waitingStack.length === 1) {
                // get the document.
                try {
                    fn.call(self, onError, function (doc) {
                        self.doc = doc;
                        // got the document. Now give it to all who are waiting or it.
                        while (self.waitingStack.length > 0) {
                            var callback = self.waitingStack.pop();
                            callback(doc);
                        }
                    });
                } catch (exn) {
                    onError(exn);
                }
            }
        }
    };
}

// monadic bind: used for chaining HypermediaQueries. Threads the result of each http request through the chain.
HypermediaQuery.bind = function(query, fn) {
    return new HypermediaQuery(function (onError,onSuccess) {
        query.run(onError, function (doc) {
            var mappedResult = null;
            try {
                fn(doc).run(onError, onSuccess);
            } catch (exn) {
                onError(exn);
            }
        });
    }, query.req);
};

HypermediaQuery.prototype = {
    include: function (includes) {
        var includes = includes || [];
        for (var i in includes) {
            this.includes.push(includes[i]);
        }
        return this;
        // var self = this;
        // return new HypermediaQuery(function (onError,onSuccess) {
        //     var _includes = includes || [];
        //     for (var i in _includes) {
        //         this.includes.push(_includes[i]);
        //     }

        //     self.run(onError,onSuccess);
        // }, this.req);
    },

    // A function that follows a link to a sub-entity or a document based on a "rel" attribute.
    // If the sub-entity is embedded in the current document, just return it without doing an http request.
    follow: function (rel) {
        var self = this;
        return HypermediaQuery.bind(this, function (doc) {
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
                            return new HypermediaQuery(function (onError,onSuccess) {
                                onSuccess(child);
                            }, self.req);
                        } else if (child.links.self) {
                            // this is a subentity link. Follow it.
                            uri = child.links.self;
                            break;
                        }
                    }
                }
            }

            return new HypermediaQuery(function (onError,onSuccess) {
                if (uri === null) {
                    onError("no such rel");
                } else {
                    // Send a request for the sub-entity/link.
                    this.req({
                        url: uri,
                        method: 'get',
                        includes: this.includes,
                        headers: { 'Accept': 'application/vnd.siren+json' }
                    }, onError, onSuccess);
                }
            }, self.req);
        });
    },

    // A function that post a form on the document. Used for RPC style calls.
    do: function (formName, params, onprogress) {
        var self = this;
        return HypermediaQuery.bind(this, function (doc) {
            // find the form based on the formName param.
            var forms = doc.forms || {};
            var form = forms[formName];
            var formInputs = form.inputs || [];
            // Enumerate the fields from the form and sets the value from the supplied "params". If the param isn't
            // available, then use the field's default value.
            var formParams = {};
            var fileParams = {};
            for (var i in formInputs) {
                var field = formInputs[i];
                if (field.type == 'file') {
                    fileParams[field.name] = typeof params[field.name] !== 'undefined' 
                        ? params[field.name] 
                        : field.value;
                } else {
                    formParams[field.name] = typeof params[field.name] !== 'undefined' 
                        ? params[field.name] 
                        : field.value;
                }
            }

            // Parse the form furl uri, which may contain a template.
            var template = parseUri(form.action);
            // Generate the form action uri from the template, substituting the form Params for the template placeholders values.
            var uri = expandUri(template, formParams);

            // Erase any formParams that were present in the uri template. This ensures they're not posted twice.
            for (var i = 0; i < template.length; i++) {
                var key = template[i].key;
                if (key) {
                    delete formParams[key];
                }
            }

            return new HypermediaQuery(function (onError,onSuccess) {
                var requestParams = {
                    url: uri,
                    method: form.method,
                    headers: { 'Accept': 'application/vnd.siren+json' },
                    files: fileParams
                };

                // used to determine if there are no formParams.
                var hasProps = false;
                for (var prop in formParams) {
                    hasProps = true;
                    break;
                }

                // Set the requestParams data/params property depending on whether this is a get/delete or a post/put.
                requestParams[isGetorDelete.test(requestParams.method) ? "params" : "data"] = hasProps ? formParams : undefined;

                var hasFiles = false;
                for (var prop in requestParams.files) {
                    hasFiles = true;
                    break;
                }

                if (hasFiles) {
                    file.httpMultipart(requestParams, onprogress).then(onSuccess, function (e) {
                        // something nasty happened;
                    });
                } else {
                    this.req(requestParams, onError, onSuccess);
                }
            }, self.req);
        });
    },

    // BEGIN: CRUD Actions
    insert: function (params) { return this.do('insert', params); },

    get: function (params) { return this.do('get', params); },

    update: function (params) { return this.do('update', params); },

    delete: function (params) { return this.do('delete', params); },
    // END: CRUD Actions

    // maps a HyperMedia document's "data" to a different shape
    map: function (mapFn) {
        return HyperMediaQuery.bind(this, function (doc) {
            return new HypermediaQuery(function (onError, onSuccess) {
                onSuccess({
                    rel: doc.rel,
                    links: doc.links,
                    forms: doc.forms,
                    props: doc.props,
                    data: mapFn(doc.data),
                    children: doc.children
                });
            });
        });
    },

    // Pull the data out of the document and give it back to the user
    resolve: function (onError,onSuccess) {
        var self = this;
        self.run(function(err) {
            onError(err);
        }, function (doc) {
            //var val = parseRsRepresentation(doc);
            if (onSuccess) {
                var val = onSuccess(doc);
            }
            //self.deferred.resolve(val);
        });

        // send back this HypermediaQuery just incase users want to hold onto it.
        return self;
    },

    // Pull the data out of the document and give it back to the user
    resolveData: function (onError,onSuccess) {
        return this.resolve(onError, function (doc){
            onSuccess(doc.data);
        });
    },

    // Pull the properties out of the document and give it back to the user
    resolveProps: function (onError,onSuccess) {
        return this.resolve(onError, function (doc){
            onSuccess(doc.props);
        });
    },

    // Pull the properties out of the document and give it back to the user
    resolveChildren: function (onError,onSuccess) {
        return this.resolve(onError, function (doc){
            onSuccess(doc.children);
        });
    }

    //then: function(callback,errback) {
    //    return this.deferred.promise.then(callback, errback);
    //}
};

exports.HypermediaClient = function(req) {
    return {
        // Gets dereferences a uri and creates a new HypermediaQuery
        from: function (uri) {
            var protectedRequest = function (requestParams, onError, onSuccess) {
                req(requestParams, onError, function (res) {
                    if (res.success) {
                        onSuccess(res);
                    } else {
                        onError(res.error);
                    }
                })
            };

            return new HypermediaQuery(function (onError,onSuccess) {
                this.req({
                    url: uri,
                    method: 'get',
                    includes: this.includes,
                    headers: { 'Accept': 'application/vnd.siren+json' },
                }, onError, onSuccess);
            }, protectedRequest);
        },
        follow: function (rel) {
            return this.from(apiRoot).follow(rel);
        }
  };
}
