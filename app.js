require("dotenv").config();

const auth = require("./auth.js");
var Context = require("./context.js");
var TestData = require("./testData.js");
var Test = require("./test");
var SuiteData = require("./suiteData.js");
var Suite = require("./suite");
var ResultsManager = require("./resultsManager");
var config = require("./config.json");

var restify = require("restify");

const logger = require("./logger.js");

logger.log("Server initialized");


const server = restify.createServer({
    name: "BotFunctionalTestingService",
    version: "1.0.0"
});

server.use(restify.plugins.acceptParser(server.acceptable));
server.use(restify.plugins.queryParser());
server.use(restify.plugins.bodyParser());

const requiredAuthToken = process.env.REQUIRED_AUTH_TOKEN;

if (requiredAuthToken) {
    server.use(auth(requiredAuthToken));
}

server.get("/test", handleRunTest);
server.post("/test", handleRunTest);
server.get("/suite", handleRunSuite);
server.post("/suite", handleRunSuite);
server.get("/getResults/:runId", handleGetTestResults);

server.listen(process.env.PORT || 3000, function () {
    logger.log("Server started listening");
    logger.log("%s listening at %s", server.name, server.url);
});

async function handleRunTest(request, response, next) {
    const context = new Context(request, response);
    logger.log(`${server.name} processing a test ${request.method} request.`);

    try {
        const testData = await TestData.fromRequest(request);
        Test.run(context, testData);
    }
    catch (err) {
        context.failure(400, err.message);
    }
}

async function handleRunSuite(request, response, next) {
    const context = new Context(request, response);
    logger.log(`${server.name} processing a suite ${request.method} request.`);
    const runId = ResultsManager.getFreshRunId();
    logger.log("Started suite run with runIn " + runId);
    // Get the suite data from the request.
    try {
        var suiteData = await SuiteData.fromRequest(request);
        logger.log("Successfully got all tests from the request for runId " + runId);
    }
    catch (err){
        response.setHeader("content-type", "application/json");
        response.send(400, {results: [], errorMessage:"Could not get tests data from request", verdict:"error"});
        ResultsManager.deleteSuiteResult(runId);
        logger.log("Could not get tests data from request for runId " + runId);
        logger.log(err);
        return;
    }
    // Send a response with status code 202 and location header based on runId, and start the tests.
    response.setHeader("content-type", "application/json");
    response.setHeader("Location", "http://" + request.headers.host + "/getResults/" + runId);
    response.send(202, "Tests are running.");
    let testSuite = new Suite(context, runId, suiteData);
    try {
        await testSuite.run();
        logger.log("Finished suite run with runId " + runId);
        setTimeout(() => {
            ResultsManager.deleteSuiteResult(runId);
            logger.log("Deleted suite results for runId " + runId);
            }, config.defaults.testSuiteResultsRetentionSeconds*1000); // Delete suite results data after a constant time after tests end.
    }
    catch (err) {
        ResultsManager.updateSuiteResults(runId, [], "Error while running test suite", "error");
        logger.log("Error occurred during suite run with runIn " + runId);
    }
}

async function handleGetTestResults(request, response, next) {
    const runId = request.params.runId;
    const activeRunIds = ResultsManager.getActiveRunIds();
    if (!activeRunIds.has(runId)) { // If runId doesn't exist (either deleted or never existed)
        response.setHeader("content-type", "application/json");
        response.send(404, {results: [], errorMessage:"RunId does not exist.", verdict:"error"});
        return;
    }
    // Else, runId exists.
    const resultsObject = ResultsManager.getSuiteResults(runId);
    if (!resultsObject) { // If results are not ready
        response.setHeader("content-type", "application/json");
        response.setHeader("Location", "http://" + request.headers.host + "/getResults/" + runId);
        response.setHeader("Retry-After", 10);
        response.send(202, "Tests are still running.");
    }
    else { // Results are ready
        response.setHeader("content-type", "application/json");
        if (resultsObject["verdict"] === "success" || resultsObject["verdict"] === "failure") { // If tests finished without errors, send response with status code 200.
            response.send(200, resultsObject);
        }
        else if (resultsObject["verdict"] === "error") { // If there was an error while running the tests, send response with status code 500
            response.send(500, resultsObject);
            ResultsManager.deleteSuiteResult(runId); // In case of an error while running test suite, delete suite results once user knows about it.
        }
    }
}
