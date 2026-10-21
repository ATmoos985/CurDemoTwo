package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.Path;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
class ExecutionApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("cutdemo.state.path",()->temp.resolve("inventory.json").toString());
        r.add("cutdemo.seed-demo-data",()->true);
    }
    @Value("${local.server.port}") int port;
    @Autowired RemnantService inventory;
    final JsonMapper json=JsonMapper.builder().build();
    final HttpClient http=HttpClient.newHttpClient();
    HttpResponse<String> call(String path,String body,String key)throws Exception {
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path));
        if(body==null)request.GET();else request.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        if(key!=null)request.header("Idempotency-Key",key);
        return http.send(request.build(),HttpResponse.BodyHandlers.ofString());
    }
    @Test void strictDecodingRejectsNullUnknownDuplicateAndFractionalValues()throws Exception {
        String base="/api/v2/execution-orders";
        for(String body:new String[]{"null","{\"planId\":\"x\",\"station\":\"A\",\"extra\":1}",
                "{\"planId\":\"x\",\"station\":\"A\",\"station\":\"B\"}","{} {}"})
            assertEquals(400,call(base,body,"test-key-123").statusCode(),body);
        for(String body:new String[]{"null","{\"operationId\":\"operation-123\",\"expectedVersion\":1.5,\"reservationSeconds\":60,\"reason\":\"\"}",
                "{\"operationId\":\"operation-123\",\"expectedVersion\":\"1\",\"reservationSeconds\":60,\"reason\":\"\"}"})
            assertEquals(400,call(base+"/missing/release",body,null).statusCode(),body);
    }
    @Test void httpLifecycleAndLegacyGuardUseOneInventoryTransaction()throws Exception {
        var fixture=new ExecutionOrderTests();fixture.inventory=inventory;fixture.task=fixture.createTask(inventory,3);
        var p=fixture.plan(inventory,false,1);
        String base="/api/v2/execution-orders";
        String body=json.writeValueAsString(new com.example.cutdemotwo.business.model.ExecutionOrder.Create(p.getPlanId(),"HTTP 裁床"));
        var created=call(base,body,"execution-http-123");assertEquals(200,created.statusCode(),created.body());
        String id=json.readTree(created.body()).get("id").asString();
        assertEquals(created.body(),call(base,body,"execution-http-123").body());
        assertEquals(409,call(base,body.replace("HTTP 裁床","不同工位"),"execution-http-123").statusCode());
        assertEquals(200,call(base+"/"+id+"/release","{\"operationId\":\"http-release\",\"expectedVersion\":1,\"reservationSeconds\":60,\"reason\":\"下达\"}",null).statusCode());
        String report=json.writeValueAsString(fixture.report(p,1));
        assertEquals(409,call("/api/cutting/report-confirm",report,null).statusCode());
        assertEquals(200,call(base+"/"+id+"/start","{\"operationId\":\"http-start\",\"expectedVersion\":2,\"reservationSeconds\":0,\"reason\":\"开工\"}",null).statusCode());
        var saved=call(base+"/"+id+"/reports",report,null);assertEquals(200,saved.statusCode(),saved.body());
        assertEquals(saved.body(),call(base+"/"+id+"/reports",report,null).body());
        var view=json.readTree(call(base+"/"+id,null,null).body());
        assertEquals("REPORTED",view.get("effectiveState").asString());
        assertFalse(view.get("reservationActive").asBoolean());
    }
    @Test void ledgerPaginationAndReconciliationAreReadOnly()throws Exception {
        byte[] before=java.nio.file.Files.readAllBytes(temp.resolve("inventory.json"));
        var first=call("/api/v2/inventory-ledger?limit=1",null,null);
        assertEquals(200,first.statusCode());
        var page=json.readTree(first.body());assertEquals(1,page.get("items").size());
        long cursor=page.get("nextCursor").asLong();assertTrue(page.get("hasMore").asBoolean());
        var next=json.readTree(call("/api/v2/inventory-ledger?limit=1&after="+cursor,null,null).body());
        assertTrue(next.get("nextCursor").asLong()>cursor);
        var reconciliation=call("/api/v2/inventory-ledger/reconciliation",null,null);
        assertEquals(200,reconciliation.statusCode());
        assertEquals("BALANCED",json.readTree(reconciliation.body()).get("status").asString(),reconciliation.body());
        assertEquals(400,call("/api/v2/inventory-ledger?limit=501",null,null).statusCode());
        assertArrayEquals(before,java.nio.file.Files.readAllBytes(temp.resolve("inventory.json")));
    }
}
