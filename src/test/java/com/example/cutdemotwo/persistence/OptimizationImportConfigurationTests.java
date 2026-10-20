package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.algorithm.solver.SolverFactory;
import com.example.cutdemotwo.business.optimization.*;
import com.example.cutdemotwo.contracts.jobs.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import javax.sql.DataSource;
import static org.junit.jupiter.api.Assertions.*;

/** Runs the actual configuration bean before the application worker is allowed to start. */
class OptimizationImportConfigurationTests {
    @TempDir Path temp;
    @Test void explicitImportCompletesBeforeServiceConstructionAndRestartDoesNotRecompute()throws Exception {
        var source=OptimizationTestDatabase.create();
        Flyway.configure().dataSource(source).load().migrate();
        OptimizationRequest input;
        try(var stream=getClass().getResourceAsStream("/static/api-v2/example-request.json")){
            input=JsonMapper.builder().build().readValue(stream,OptimizationRequest.class);
        }
        String id=UUID.randomUUID().toString();
        var job=new OptimizationJob(id,"2.0",input.clientRequestId(),StoredOptimizationJob.inputHash(input),
                "QUEUED","QUEUED",Instant.now().toString(),null,null,input.problem().timeLimitSeconds(),null,null,"queued");
        try(var file=new FileOptimizationJobStore(temp)){file.save(new StoredOptimizationJob("configuration-import-key",input,job,null));}
        byte[] before=Files.readAllBytes(temp.resolve(id+".json"));
        for(int retry=0;retry<2;retry++)try(var context=new AnnotationConfigApplicationContext()){
            context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test",Map.of(
                    "cutdemo.jobs.storage","mysql","cutdemo.jobs.import-path",temp.toString())));
            context.registerBean(DataSource.class,()->source);
            context.registerBean(InventoryStore.class,()->new JdbcInventoryStore(source));
            context.registerBean(SolverFactory.class,()->new SolverFactory(List.of()));
            context.register(OptimizationConfiguration.class,OptimizationService.class);
            context.refresh();
            var service=context.getBean(OptimizationService.class);
            assertEquals("FAILED",service.get(id).state());
            assertEquals("PROCESS_RESTARTED",service.get(id).code());
            assertEquals(input,service.input(id));
            assertEquals(id,service.submit("configuration-import-key",input).id());
        }
        assertArrayEquals(before,Files.readAllBytes(temp.resolve(id+".json")));
        assertEquals(1,new org.springframework.jdbc.core.JdbcTemplate(source)
                .queryForObject("SELECT COUNT(*) FROM optimization_attempt WHERE outcome='IMPORTED'",Integer.class));
    }
    @Test void importSettingCannotSilentlyRunInFileMode() {
        try(var context=new AnnotationConfigApplicationContext()){
            context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test",Map.of(
                    "cutdemo.jobs.storage","file","cutdemo.jobs.import-path",temp.toString())));
            context.registerBean(InventoryStore.class,()->new FileInventoryStore(temp.resolve("inventory.json").toString()));
            context.register(OptimizationConfiguration.class);
            assertThrows(org.springframework.beans.BeansException.class,context::refresh);
        }
    }
}
