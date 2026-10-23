package com.example.cutdemotwo;

import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.time.Duration;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
class InventoryCountApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties) {
        properties.add("cutdemo.state.path",()->temp.resolve("stock.json").toString());
        properties.add("cutdemo.jobs.path",()->temp.resolve("jobs").toString());
        properties.add("cutdemo.seed-demo-data",()->true);
        properties.add("cutdemo.integration.enabled",()->false);
    }
    @Value("${local.server.port}") int port;
    final JsonMapper json=JsonMapper.builder().build();
    final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    HttpResponse<String> call(String path,String body,String key)throws Exception {
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).timeout(Duration.ofSeconds(10));
        if(body==null)request.GET();
        else request.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        if(key!=null)request.header("Idempotency-Key",key);
        return http.send(request.build(),HttpResponse.BodyHandlers.ofString());
    }
    HttpResponse<String> post(String body,String key)throws Exception {return call("/api/v2/inventory-counts",body,key);}
    byte[] saved()throws Exception {return Files.readAllBytes(temp.resolve("stock.json"));}
    JsonNode options()throws Exception {
        var response=call("/api/v2/inventory-counts/options",null,null);
        assertEquals(200,response.statusCode(),response.body());return json.readTree(response.body());
    }
    JsonNode material(JsonNode options,String id) {
        for(var row:options.path("materials"))if(id.equals(row.path("id").asString()))return row;
        fail("材料未出现在盘点选项中: "+id);return null;
    }
    String command(long revision,String type,String id,boolean present,double width,double length) {
        var root=json.createObjectNode();root.put("expectedRevision",revision);root.put("reason","HTTP 实物复核");root.put("operator","测试仓管");
        var line=root.putArray("materials").addObject();line.put("type",type);line.put("id",id);
        line.put("present",present);line.put("width",width);line.put("length",length);return root.toString();
    }

    @ParameterizedTest
    @ValueSource(strings={"null","empty","unknown","trailing","duplicate","nullLine","floatRevision",
            "stringWidth","nullReason","missingPresent","oversize","overflowRevision","missingKey"})
    void strictInputNeverChangesInventory(String variant)throws Exception {
        long revision=options().path("revision").asLong();
        var valid=json.readTree(command(revision,"remnant","REM-202609-001",true,2000,1600));
        String body=switch(variant) {
            case "null" -> "null";
            case "empty" -> "{}";
            case "unknown" -> valid.toString().replace("\"reason\":","\"unknown\":1,\"reason\":");
            case "trailing" -> valid+" {}";
            case "duplicate" -> valid.toString().replace("\"reason\":","\"reason\":\"重复\",\"reason\":");
            case "nullLine" -> valid.toString().replace("[{","[null,{");
            case "floatRevision" -> valid.toString().replace("\"expectedRevision\":"+revision,"\"expectedRevision\":0.1");
            case "stringWidth" -> valid.toString().replace("\"width\":2000.0","\"width\":\"2000\"");
            case "nullReason" -> valid.toString().replace("\"HTTP 实物复核\"","null");
            case "missingPresent" -> valid.toString().replace("\"present\":true,","");
            case "oversize" -> " ".repeat(262145);
            case "overflowRevision" -> valid.toString().replace("\"expectedRevision\":"+revision,"\"expectedRevision\":9223372036854775808");
            default -> valid.toString();
        };
        byte[] before=saved();
        var response=post(body,"missingKey".equals(variant)?null:"strict-count-http");
        assertEquals(400,response.statusCode(),variant+": "+response.body());
        assertEquals("INVALID_INPUT",json.readTree(response.body()).path("code").asString());
        assertArrayEquals(before,saved(),variant);
    }

    @Test void postReplayConflictsAndReadOnlyQueriesPreserveTheSameDocument()throws Exception {
        byte[] initial=saved();var snapshot=options();
        assertEquals(200,call("/api/v2/inventory-counts",null,null).statusCode());
        assertArrayEquals(initial,saved(),"列表和选项查询不能改写库存");
        String body=command(snapshot.path("revision").asLong(),"roll","ROLL-2026-0920",true,2000,54000);
        var posted=post(body,"http-count-post-001");assertEquals(200,posted.statusCode(),posted.body());
        var receipt=json.readTree(posted.body());assertEquals(-2,receipt.path("lines").get(0).path("differenceAreaM2").asDouble(),1e-9);
        byte[] after=saved();long revision=options().path("revision").asLong();
        var replay=post(body,"http-count-post-001");assertEquals(200,replay.statusCode(),replay.body());
        assertEquals(posted.body(),replay.body());assertArrayEquals(after,saved(),"原键重放不能改写库存文件或推进版本");
        assertEquals(revision,options().path("revision").asLong());
        var changed=post(body.replace("54000.0","54500.0"),"http-count-post-001");
        assertEquals(409,changed.statusCode(),changed.body());
        var stale=post(body,"http-count-stale-001");assertEquals(409,stale.statusCode(),stale.body());
        assertEquals("INVENTORY_CONFLICT",json.readTree(stale.body()).path("code").asString());
        var listed=call("/api/v2/inventory-counts",null,null);assertEquals(200,listed.statusCode());
        assertEquals(receipt,json.readTree(listed.body()).get(0));
        assertArrayEquals(after,saved(),"冲突及读取不能修改已过账状态");
    }

    @Test void missingAndRecoveredRemnantKeepsLineageAndReturnsToQuarantine()throws Exception {
        var before=json.readTree(saved());String id="REM-202609-001";JsonNode original=null;
        for(var row:before.path("remnants"))if(id.equals(row.path("id").asString()))original=row;
        assertNotNull(original);
        var missing=post(command(options().path("revision").asLong(),"remnant",id,false,2000,0),"http-count-missing-001");
        assertEquals(200,missing.statusCode(),missing.body());
        var missingLine=json.readTree(missing.body()).path("lines").get(0);
        assertEquals("LOST",missingLine.path("afterStatus").asString());
        assertEquals(-3.2,missingLine.path("differenceAreaM2").asDouble(),1e-9);
        var lost=material(options(),id);assertEquals("LOST",lost.path("status").asString());
        assertEquals(1600,lost.path("length").asDouble());assertTrue(lost.path("allowed").asBoolean());
        var found=post(command(options().path("revision").asLong(),"remnant",id,true,2000,1600),"http-count-found-001");
        assertEquals(200,found.statusCode(),found.body());
        var foundLine=json.readTree(found.body()).path("lines").get(0);
        assertEquals("QUARANTINED",foundLine.path("afterStatus").asString());
        assertEquals(3.2,foundLine.path("differenceAreaM2").asDouble(),1e-9);
        assertEquals("QUARANTINED",material(options(),id).path("status").asString());
        var after=json.readTree(saved());
        for(var row:after.path("remnants"))if(id.equals(row.path("id").asString())) {
            var expected=(tools.jackson.databind.node.ObjectNode)original.deepCopy();expected.put("status","QUARANTINED");
            assertEquals(expected,row,"找回必须保留来源、疵点、库位与原始几何");
        }
        assertEquals(before.path("receipts"),after.path("receipts"));assertEquals(before.path("tasks"),after.path("tasks"));
        var available=call("/api/remnants?rollId=ALL",null,null);assertEquals(200,available.statusCode());
        for(var row:json.readTree(available.body()))assertNotEquals(id,row.path("id").asString(),"找回待检料头不能进入可用库存");
        byte[] recovered=saved();
        var foundReplay=post(command(json.readTree(found.body()).path("command").path("expectedRevision").asLong(),"remnant",id,true,2000,1600),"http-count-found-001");
        assertEquals(200,foundReplay.statusCode());assertEquals(found.body(),foundReplay.body());assertArrayEquals(recovered,saved());
    }
}
