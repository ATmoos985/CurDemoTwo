package com.example.cutdemotwo;

import com.example.cutdemotwo.persistence.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.json.JsonMapper;
import javax.sql.DataSource;
import java.net.*;
import java.net.http.*;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

/** Exercises the actual Spring bean wiring and migrations, using isolated H2 in MySQL mode. */
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={
        "cutdemo.storage=mysql","cutdemo.jobs.storage=mysql","cutdemo.seed-demo-data=false"})
class OptimizationJdbcApiTests {
    static final org.springframework.jdbc.datasource.DriverManagerDataSource database=OptimizationTestDatabase.create();
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r){
        r.add("cutdemo.database.url",database::getUrl);
        r.add("cutdemo.database.username",database::getUsername);
        r.add("cutdemo.database.password",database::getPassword);
    }
    @Value("${local.server.port}") int port;
    @Autowired OptimizationJobStore store;
    @Autowired DataSource source;
    final HttpClient http=HttpClient.newHttpClient();
    final JsonMapper json=JsonMapper.builder().build();
    HttpResponse<String> get(String path)throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+path)).GET().build(),HttpResponse.BodyHandlers.ofString());
    }
    @Test void explicitDatabaseModeRunsHttpJobAndArchivesAttemptWithoutInventoryWrites()throws Exception {
        assertInstanceOf(JdbcOptimizationJobStore.class,store);
        var capabilities=json.readTree(get("/api/v2/capabilities").body());
        assertTrue(capabilities.path("features").path("distributedWorkers").asBoolean());
        assertEquals("jdbc-leases",capabilities.path("features").path("storage").asText());
        var example=get("/api-v2/example-request.json");
        var accepted=http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v2/optimization-jobs"))
                .header("Content-Type","application/json").header("Idempotency-Key",UUID.randomUUID().toString())
                .POST(HttpRequest.BodyPublishers.ofString(example.body())).build(),HttpResponse.BodyHandlers.ofString());
        assertEquals(202,accepted.statusCode(),accepted.body());
        String id=json.readTree(accepted.body()).path("id").asText();
        long until=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while(!store.load().get(0).job().terminal() && System.nanoTime()<until)Thread.sleep(20);
        assertEquals("SUCCEEDED",store.load().get(0).job().state());
        assertEquals(200,get("/api/v2/optimization-results/"+id).statusCode());
        var sql=new JdbcTemplate(source);
        assertEquals(1,sql.queryForObject("SELECT COUNT(*) FROM optimization_attempt WHERE outcome='SUCCEEDED'",Integer.class));
        assertEquals(1,sql.queryForObject("SELECT COUNT(*) FROM optimization_result",Integer.class));
        assertEquals(0,sql.queryForObject("SELECT COUNT(*) FROM mother_roll",Integer.class));
        assertEquals(0,sql.queryForObject("SELECT COUNT(*) FROM cutting_task",Integer.class));
        assertEquals(0,sql.queryForObject("SELECT COUNT(*) FROM cut_report",Integer.class));
    }
}
