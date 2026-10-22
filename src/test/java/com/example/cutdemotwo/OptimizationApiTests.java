package com.example.cutdemotwo;

import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.business.cutting.RemnantService;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import tools.jackson.databind.json.JsonMapper;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
class OptimizationApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r){
        r.add("cutdemo.state.path",()->temp.resolve("inventory.json").toString());r.add("cutdemo.seed-demo-data",()->false);
    }
    @Value("${local.server.port}") int port;
    @Autowired RemnantService inventory;
    final JsonMapper json=JsonMapper.builder().build();
    final HttpClient http=HttpClient.newHttpClient();
    OptimizationRequest input(){return new OptimizationRequest("2.0","NESTING_2D","ERP-001",new NestingProblem("1","mm",
            new NestingProblem.Material("external-material",NestingProblem.Shape.rectangle(2000,3000),List.of(),false),
            List.of(new NestingProblem.Part(7,"external-order",NestingProblem.Shape.rectangle(2000,1000),3,false)),
            new NestingProblem.Process("CROSSCUT","SHEET","left-top","horizontal",0,200,300,0,"INPUT_ORDER"),"auto",3),false,true);}
    HttpResponse<String> call(String path,String body,String key)throws Exception{
        var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path));
        if(body!=null)builder.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body));else builder.GET();
        if(key!=null)builder.header("Idempotency-Key",key);
        return http.send(builder.build(),HttpResponse.BodyHandlers.ofString());
    }
    OptimizationJob waitJob(String id)throws Exception{
        for(int i=0;i<100;i++){var response=call("/api/v2/optimization-jobs/"+id,null,null);assertEquals(200,response.statusCode());
            var job=json.readValue(response.body(),OptimizationJob.class);if(job.terminal())return job;Thread.sleep(20);}
        throw new AssertionError("job did not finish");
    }
    @Test void realHttpLifecycleArchivesPureComputationAndLeavesAllInventoryDataUntouched()throws Exception{
        var validation=call("/api/v2/problem-validations",json.writeValueAsString(input()),null);assertEquals(200,validation.statusCode(),validation.body());
        String key=UUID.randomUUID().toString();var accepted=call("/api/v2/optimization-jobs",json.writeValueAsString(input()),key);
        assertEquals(202,accepted.statusCode(),accepted.body());var job=json.readValue(accepted.body(),OptimizationJob.class);
        assertEquals("/api/v2/optimization-jobs/"+job.id(),accepted.headers().firstValue("Location").orElseThrow());
        assertFalse(accepted.body().contains(key));assertEquals("SUCCEEDED",waitJob(job.id()).state());
        var result=call("/api/v2/optimization-results/"+job.id(),null,null);assertEquals(200,result.statusCode(),result.body());
        var value=json.readValue(result.body(),OptimizationResult.class);assertEquals("COMPLETE",value.fulfillmentStatus());assertTrue(value.meetsRequirement());
        assertEquals(input(),json.readValue(call("/api/v2/optimization-jobs/"+job.id()+"/input",null,null).body(),OptimizationRequest.class));
        assertEquals(job.id(),json.readValue(call("/api/v2/optimization-jobs",json.writeValueAsString(input()),key).body(),OptimizationJob.class).id());
        var cancel=call("/api/v2/optimization-jobs/"+job.id()+"/cancellations","",null);assertEquals(200,cancel.statusCode());assertEquals("SUCCEEDED",json.readTree(cancel.body()).get("state").asText());
        assertTrue(inventory.getMotherRolls().isEmpty());assertTrue(inventory.getAllRemnants().isEmpty());assertTrue(inventory.listTasks().isEmpty());
        assertFalse(Files.exists(temp.resolve("inventory.json")));assertTrue(Files.exists(temp.resolve("inventory.json.jobs").resolve(job.id()+".json")));
    }
    @Test void sameCanonicalRequestWithReorderedObjectKeysReusesJobAndDifferentInputConflicts()throws Exception{
        String key=UUID.randomUUID().toString(),body=json.writeValueAsString(input());
        var first=call("/api/v2/optimization-jobs",body,key);assertEquals(202,first.statusCode());
        String rearranged="{\"requireComplete\":true,\"allowFallback\":false,\"problem\":"+json.writeValueAsString(input().problem())+",\"clientRequestId\":\"ERP-001\",\"problemType\":\"NESTING_2D\",\"schemaVersion\":\"2.0\"}";
        var second=call("/api/v2/optimization-jobs",rearranged,key);assertEquals(202,second.statusCode());assertEquals(json.readTree(first.body()).get("id"),json.readTree(second.body()).get("id"));
        var conflict=call("/api/v2/optimization-jobs",body.replace("ERP-001","ERP-002"),key);assertEquals(409,conflict.statusCode());assertEquals("IDEMPOTENCY_CONFLICT",json.readTree(conflict.body()).get("code").asText());
    }
    @Test void comparisonUsesArchivedResultsAndDoesNotWriteInventory()throws Exception{
        var response=call("/api/v2/optimization-jobs",json.writeValueAsString(input()),UUID.randomUUID().toString());
        assertEquals(202,response.statusCode());String id=json.readTree(response.body()).get("id").asString();waitJob(id);
        var comparison=call("/api/v2/result-comparisons?leftId="+id+"&rightId="+id,null,null);
        assertEquals(200,comparison.statusCode(),comparison.body());
        var result=json.readValue(comparison.body(),ResultComparison.class);assertTrue(result.sameHardConstraints());
        assertTrue(result.metrics().stream().allMatch(m->m.rightMinusLeft()==0));
        assertEquals(404,call("/api/v2/result-comparisons?leftId=missing&rightId="+id,null,null).statusCode());
        assertEquals(400,call("/api/v2/result-comparisons",null,null).statusCode());
        assertFalse(Files.exists(temp.resolve("inventory.json")));
    }
    @Test void invalidBodyIsBoundedStrictAndErrorsAreStructured()throws Exception{
        String body=json.writeValueAsString(input());
        for(String invalid:List.of(body.replace("\"quantity\":3","\"quantity\":3.5"),body.replace("\"quantity\":3","\"quantity\":\"3\""),body.replace("\"quantity\":3","\"quantity\":null"),body.replace("\"allowFallback\":false,",""),body.replace("\"allowFallback\":false","\"allowFallback\":false,\"allowFallback\":true"),body.replace("\"requireComplete\":true","\"requireComplete\":true,\"tenantId\":\"admin\""),body+" {}")){
            var response=call("/api/v2/optimization-jobs",invalid,UUID.randomUUID().toString());assertEquals(400,response.statusCode(),response.body());
            var error=json.readTree(response.body());assertEquals("INVALID_INPUT",error.get("code").asText());assertTrue(error.has("traceId"));assertTrue(error.has("fieldErrors"));assertFalse(error.get("retryable").asBoolean());
        }
        assertEquals(400,call("/api/v2/optimization-jobs",body,null).statusCode());
        assertEquals(413,call("/api/v2/optimization-jobs"," ".repeat(262145),UUID.randomUUID().toString()).statusCode());
    }
    @Test void unsupportedProfilesAndUnknownResourcesHaveExplicitHttpSemantics()throws Exception{
        var unsupported=call("/api/v2/problem-validations",json.writeValueAsString(input()).replace("NESTING_2D","LINEAR_1D"),null);
        assertEquals(422,unsupported.statusCode());assertEquals("UNSUPPORTED_CONSTRAINT",json.readTree(unsupported.body()).get("code").asText());
        assertEquals(404,call("/api/v2/optimization-jobs/unknown",null,null).statusCode());assertEquals(404,call("/api/v2/optimization-results/unknown",null,null).statusCode());
        var capability=call("/api/v2/capabilities",null,null);assertEquals(200,capability.statusCode());
        var c=json.readTree(capability.body());assertEquals("nesting-v1",c.get("inputProfile").asText());assertFalse(c.get("features").get("distributedWorkers").asBoolean());assertFalse(c.get("features").get("inventoryWrites").asBoolean());
    }
    @Test void publishedOpenApiSchemaAndExampleAreAvailableAndExampleCanBeValidated()throws Exception{
        var openapi=call("/api-v2/openapi.json",null,null);assertEquals(200,openapi.statusCode());assertEquals("3.1.0",json.readTree(openapi.body()).get("openapi").asText());
        var schema=call("/api-v2/optimization-request.schema.json",null,null);assertEquals(200,schema.statusCode());assertFalse(json.readTree(schema.body()).get("additionalProperties").asBoolean());
        var example=call("/api-v2/example-request.json",null,null);assertEquals(200,example.statusCode());assertEquals(200,call("/api/v2/problem-validations",example.body(),null).statusCode());
    }

    @Test void slittingExampleIsStrictAndReturnsVerifiedStringOrderFulfillment()throws Exception {
        String body=call("/api-v2/example-slitting-request.json",null,null).body();
        assertEquals(200,call("/api/v2/problem-validations",body,null).statusCode());
        assertEquals(422,call("/api/v2/problem-validations",body.replace("3000","3001"),null).statusCode());
        assertEquals(400,call("/api/v2/problem-validations",body.replace("\"leftTrimMm\": 10,", ""),null).statusCode());
        assertEquals(400,call("/api/v2/problem-validations",body.replace("\"widthMm\": 500","\"widthMm\": 500.5"),null).statusCode());
        assertEquals(400,call("/api/v2/problem-validations",body.replace("\"profile\": \"FAST\"","\"profile\": \"FAST\", \"unknown\": true"),null).statusCode());
        var accepted=call("/api/v2/optimization-jobs",body,UUID.randomUUID().toString());
        assertEquals(202,accepted.statusCode(),accepted.body());var id=json.readTree(accepted.body()).get("id").asText();
        OptimizationJob job=null;
        for(int i=0;i<200;i++){job=json.readValue(call("/api/v2/optimization-jobs/"+id,null,null).body(),OptimizationJob.class);if(job.terminal())break;Thread.sleep(50);}
        assertEquals("SUCCEEDED",job.state(),job.toString());
        var result=json.readValue(call("/api/v2/optimization-results/"+id,null,null).body(),OptimizationResult.class);
        assertEquals("COMPLETE",result.fulfillmentStatus());assertNull(result.layout());assertNotNull(result.slitting());
        assertTrue(inventory.getMotherRolls().isEmpty());assertFalse(Files.exists(temp.resolve("inventory.json")));
    }
}
