package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
class IntegrationApiTests {
    @TempDir static Path temp;
    static final String TOKEN="test-only-api-integration-0123456789";
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r){
        r.add("cutdemo.state.path",()->temp.resolve("stock.json").toString());r.add("cutdemo.seed-demo-data",()->true);
        r.add("cutdemo.integration.enabled",()->true);r.add("cutdemo.integration.token",()->TOKEN);
    }
    @Value("${local.server.port}") int port;
    @Autowired RemnantService inventory;
    final JsonMapper json=JsonMapper.builder().build();
    HttpResponse<String> call(String path,String body,String token)throws Exception{
        var req=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v2/integration-deliveries"+path));
        if(body==null)req.GET();else req.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        if(token!=null)req.header("Authorization","Bearer "+token);
        return HttpClient.newHttpClient().send(req.build(),HttpResponse.BodyHandlers.ofString());
    }
    @Test void malformedPaginationIsNotARetryableStorageFailure()throws Exception {
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        for(String query:new String[]{"?after=bad","?limit=2.5","?after=-1","?limit=101","?after=9223372036854775808"}){
            var response=call(query,null,TOKEN);assertEquals(400,response.statusCode(),response.body());
            assertEquals("INVALID_INPUT",json.readTree(response.body()).get("code").asString());
            assertFalse(json.readTree(response.body()).get("retryable").asBoolean());
        }
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
    }
    @Test void strictBodiesAndUnauthorizedRequestsNeverAcquireAnAttempt()throws Exception {
        var before=call("",null,TOKEN).body();
        for(String body:new String[]{"null","[]","{}","{\"requestId\":2}","{\"requestId\":2.5}","{\"requestId\":true}",
                "{\"requestId\":\"a\",\"approved\":true}","{\"requestId\":\"a\",\"requestId\":\"b\"}",
                "{\"requestId\":\"a\",\"retryOf\":2}","{\"requestId\":\"a\"} {}","{\"requestId\":\""+"x".repeat(8200)+"\"}"})
            assertEquals(400,call("/claims",body,TOKEN).statusCode(),body.substring(0,Math.min(100,body.length())));
        assertEquals(401,call("/claims","{\"requestId\":\"unauthorized\"}",null).statusCode());
        assertEquals(401,call("",null,"wrong").statusCode());assertEquals(before,call("",null,TOKEN).body());
        for(String field:new String[]{"token","status","externalReceipt","reason"}) {
            String body="{\"token\":\"00000000-0000-0000-0000-000000000000\",\"status\":\"ACCEPTED\",\"externalReceipt\":\"receipt\",\"reason\":null}";
            var tree=(tools.jackson.databind.node.ObjectNode)json.readTree(body);tree.put(field,2);
            assertEquals(400,call("/unknown/acknowledgements",json.writeValueAsString(tree),TOKEN).statusCode());
        }
    }
    @Test void realHttpClaimReplayAndAcknowledgementDoNotChangeStock()throws Exception {
        inventory.scrapRemnant("REM-202609-001","集成 API 验证");byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        var first=call("/claims","{\"requestId\":\"http-claim\"}",TOKEN);assertEquals(200,first.statusCode(),first.body());
        assertEquals(first.body(),call("/claims","{\"requestId\":\"http-claim\"}",TOKEN).body());
        var lease=json.readTree(first.body());String event=lease.get("event").get("id").asString(),token=lease.get("attempt").get("token").asString();
        String ack=json.writeValueAsString(java.util.Map.of("token",token,"status","ACCEPTED","externalReceipt","wms-http-1"));
        var confirmed=call("/"+event+"/acknowledgements",ack,TOKEN);assertEquals(200,confirmed.statusCode(),confirmed.body());
        assertEquals(confirmed.body(),call("/"+event+"/acknowledgements",ack,TOKEN).body());
        assertEquals(1,json.readTree(call("",null,TOKEN).body()).get("acknowledgedThrough").asLong());
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
    }
}
