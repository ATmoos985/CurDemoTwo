package com.example.cutdemotwo.linear;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;
import java.net.*;
import java.net.http.*;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
class LinearCutHttpTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry registry) {
        registry.add("cutdemo.state.path",()->temp.resolve("inventory.json").toString());
        registry.add("cutdemo.seed-demo-data",()->false);
    }
    @Value("${local.server.port}") int port;
    private final HttpClient http=HttpClient.newHttpClient();
    private final JsonMapper json=JsonMapper.builder().build();
    private HttpResponse<String> post(String body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/linear/tasks"))
                .header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());
    }
    @Test void rejectsFractionalAndUnknownFieldsAtHttpBoundary() throws Exception {
        String body=json.writeValueAsString(LinearCutTests.input("A"));
        assertEquals(400,post(body.replace("\"motherWidth\":4600","\"motherWidth\":4600.5")).statusCode());
        assertEquals(400,post(body.replace("\"motherWidth\":4600","\"unknown\":true,\"motherWidth\":4600")).statusCode());
        assertEquals(400,post(body+" {}").statusCode());
        assertEquals(400,post("null").statusCode());
    }
    @Test void fullHttpTaskIsReadableByItsIdAndDoesNotExposeLegacyEndpoints() throws Exception {
        var created=post(json.writeValueAsString(LinearCutTests.input("HTTP 订单")));
        assertEquals(200,created.statusCode(),created.body());
        String id=json.readTree(created.body()).get("taskId").asString();
        String base="http://localhost:"+port;
        long deadline=System.nanoTime()+java.time.Duration.ofSeconds(60).toNanos();
        String status="RUNNING";
        while(status.equals("RUNNING")&&System.nanoTime()<deadline){
            var result=http.send(HttpRequest.newBuilder(URI.create(base+"/api/linear/tasks/"+id)).GET().build(),HttpResponse.BodyHandlers.ofString());
            assertEquals(200,result.statusCode(),result.body());
            var value=json.readTree(result.body());status=value.get("status").asString();
            if(!status.equals("RUNNING")){assertEquals("SUCCEEDED",status,result.body());assertTrue(value.get("preview").get("success").asBoolean());}
            else Thread.sleep(100);
        }
        assertEquals("SUCCEEDED",status);
        assertEquals(404,http.send(HttpRequest.newBuilder(URI.create(base+"/api/linear/tasks/not-a-task")).GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode());
        assertEquals(404,http.send(HttpRequest.newBuilder(URI.create(base+"/api/cutting/v2/preview")).POST(HttpRequest.BodyPublishers.ofString("{}")).header("Content-Type","application/json").build(),HttpResponse.BodyHandlers.ofString()).statusCode());
    }
    private HttpResponse<String> send(String method,String id) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/linear/tasks/"+id)).method(method,HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofString());
    }
    @Test void finishedTaskIsReleasedOnceWhileRunningTaskIsKept() throws Exception {
        String id=json.readTree(post(json.writeValueAsString(LinearCutTests.input("释放订单"))).body()).get("taskId").asString();
        var early=send("DELETE",id);
        assertTrue(early.statusCode()==409||early.statusCode()==204,early.body());
        if(early.statusCode()==409){
            long deadline=System.nanoTime()+java.time.Duration.ofSeconds(60).toNanos();
            String status="RUNNING";
            while(status.equals("RUNNING")&&System.nanoTime()<deadline){
                status=json.readTree(send("GET",id).body()).get("status").asString();
                if(status.equals("RUNNING"))Thread.sleep(100);
            }
            assertEquals("SUCCEEDED",status);
            assertEquals(204,send("DELETE",id).statusCode());
        }
        assertEquals(404,send("GET",id).statusCode());
        assertEquals(404,send("DELETE",id).statusCode());
        assertEquals(404,send("DELETE","not-a-task").statusCode());
    }
}
