var saRequest = require('superagent');
var hypermedia = require('./ResourceFinder.js');

function superAgentHttpRequestFactory (settings) {
    var baseUrl = settings.baseUrl || "";
    baseUrl = baseUrl.endsWith ("/")
        ? baseUrl
        : baseUrl + "/"    
    return function _request(reqParams, cb) {
        console.log('requesting: ' + reqParams.url);
        var path = reqParams.url || "";
        var url = path.startsWith("http://") || path.startsWith("https://")
            ? path
            : baseUrl + reqParams.url;

        var req = saRequest(reqParams.method,url)
            .set ("X-RS-Session-Token", settings.sessionToken)
            .set ("X-RS-Internal-Access", settings.internalAccessKey)
            
        var includes = reqParams.includes || [];
        if (includes.length > 0) {
            req.query({ "include": includes });
        }

        for (var headerName in (reqParams.headers || {})) {
            req.set(headerName,reqParams.headers[headerName]);
        }
            
        req.end(function(err,res){
            if (err) {
                console.log('error:' + err);
            }
            cb(res.body);
        });
    };
}

let settings = {
    baseUrl: "https://www.somesite.com/",
    sessionToken: ""
}

let client = new hypermedia.HypermediaClient(superAgentHttpRequestFactory(settings));

var offering = client
    .from("query/offering?offering_id=4201408783290348&include=order-info")
    .include(["order-info"]);

var offeringPhotos = offering.follow("offering-photos");

offering.resolveChildren(function (children) {
    console.log(children);
});

offeringPhotos.resolve(function (data) {
    console.log('data1');
});

offeringPhotos.resolve(function (data) {
    console.log('data2');
});
