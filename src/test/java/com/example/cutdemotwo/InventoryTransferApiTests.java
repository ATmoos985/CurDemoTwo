package com.example.cutdemotwo;

import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
class InventoryTransferApiTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r){r.add("cutdemo.state.path",()->temp.resolve("stock.json").toString());r.add("cutdemo.seed-demo-data",()->true);}
    @Value("${local.server.port}") int port;
    final JsonMapper json=JsonMapper.builder().build();
    HttpResponse<String> call(String path,String body,String key)throws Exception{
        var req=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v2/inventory-transfers"+path));
        if(body==null)req.GET();else req.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        if(key!=null)req.header("Idempotency-Key",key);
        return HttpClient.newHttpClient().send(req.build(),HttpResponse.BodyHandlers.ofString());
    }
    @Test void strictInputNeverChangesInventory()throws Exception {
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        String valid="{\"expectedRevision\":0,\"destination\":\"B\",\"reason\":\"测试\",\"operator\":\"仓管\",\"materials\":[{\"type\":\"roll\",\"id\":\"ROLL-2026-0920\"}]}";
        for(String body:new String[]{"null","{}",valid.replace("0,","null,"),valid.replace("0,","1.5,"),valid.replace("0,","\"0\","),valid.replace("\"expectedRevision\":0,",""),valid.replace("\"destination\":","\"unknown\":1,\"destination\":"),valid.replace("\"destination\":","\"destination\":\"C\",\"destination\":"),valid+" {}",valid.replace("[{\"type\":\"roll\",\"id\":\"ROLL-2026-0920\"}]","[null]")})
            assertEquals(400,call("",body,"strict-transfer").statusCode(),body);
        assertEquals(400,call("",valid,null).statusCode());
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
    }
    @Test void postReplayAndReadOnlyListUseTheSameDocument()throws Exception {
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        var options=call("/options",null,null);assertEquals(200,options.statusCode());
        long revision=json.readTree(options.body()).get("revision").asLong();
        assertEquals(200,call("",null,null).statusCode());assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
        String body="{\"expectedRevision\":"+revision+",\"destination\":\"HTTP B\",\"reason\":\"测试\",\"operator\":\"仓管\",\"materials\":[{\"type\":\"roll\",\"id\":\"ROLL-2026-0920\"}]}";
        var posted=call("",body,"http-transfer-1");assertEquals(200,posted.statusCode(),posted.body());
        assertEquals(posted.body(),call("",body,"http-transfer-1").body());
        assertEquals(409,call("",body.replace("HTTP B","HTTP C"),"http-transfer-1").statusCode());
        assertEquals(409,call("",body,"http-stale-transfer").statusCode());
        assertEquals(json.readTree(posted.body()),json.readTree(call("",null,null).body()).get(0));
    }
}
