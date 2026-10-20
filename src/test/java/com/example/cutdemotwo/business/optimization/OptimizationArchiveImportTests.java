package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.solver.*;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.persistence.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.example.cutdemotwo.business.optimization.OptimizationServiceTests.*;

class OptimizationArchiveImportTests {
    @TempDir Path temp;
    JdbcOptimizationJobStore target;
    javax.sql.DataSource source;
    JdbcTemplate sql;
    final JsonMapper json=JsonMapper.builder().build();
    @BeforeEach void database(){
        source=OptimizationTestDatabase.create();Flyway.configure().dataSource(source).load().migrate();
        target=new JdbcOptimizationJobStore(source);sql=new JdbcTemplate(source);
    }
    StoredOptimizationJob queued(String key) {
        var input=request("crosscut",1,10,false);
        var job=new OptimizationJob(UUID.randomUUID().toString(),"2.0",input.clientRequestId(),StoredOptimizationJob.inputHash(input),
                "QUEUED","QUEUED",Instant.now().toString(),null,null,10,null,null,"queued");
        return new StoredOptimizationJob(key,input,job,null);
    }
    StoredOptimizationJob complete(String key) {
        var d=queued(key);
        var layout=new SolverFactory(List.of(new CrossCutSolverService())).solve(d.input().problem(),false);
        var result=new OptimizationResult(d.job().id(),d.job().id(),d.job().inputHash(),"2.0","PASSED","COMPLETE",true,"COMPLETED",List.of(),layout);
        return d.transition("SUCCEEDED","STOPPED",null,"done",result,System.currentTimeMillis());
    }
    void save(StoredOptimizationJob... docs) {
        try(var files=new FileOptimizationJobStore(temp)){for(var doc:docs)files.save(doc);}
    }
    @Test void importsCompleteAndInterruptedJobsWithOriginalIdentityAndRawEvidence()throws Exception {
        var finished=complete("import-complete");var interrupted=queued("import-interrupted");save(finished,interrupted);
        var original=Files.readAllBytes(temp.resolve(interrupted.job().id()+".json"));
        assertEquals(2,OptimizationArchiveImport.run(target,temp));
        assertEquals(finished,target.find(finished.job().id()));
        var failed=target.find(interrupted.job().id());
        assertEquals("FAILED",failed.job().state());assertEquals("PROCESS_RESTARTED",failed.job().code());
        assertEquals(interrupted.input(),failed.input());assertEquals(interrupted.job().createdAt(),failed.job().createdAt());
        assertEquals(interrupted.job().inputHash(),failed.job().inputHash());assertNull(failed.result());
        assertArrayEquals(original,Files.readAllBytes(temp.resolve(interrupted.job().id()+".json")));
        assertEquals(new String(original,java.nio.charset.StandardCharsets.UTF_8),
                sql.queryForObject("SELECT original_json FROM optimization_archive_entry WHERE job_id=?",String.class,interrupted.job().id()));
        assertEquals(2,sql.queryForObject("SELECT COUNT(*) FROM optimization_attempt WHERE token=0 AND outcome='IMPORTED'",Integer.class));
        try(var service=new OptimizationService(new SolverFactory(List.of()),target,1,1,100)) {
            assertEquals(finished.job().id(),service.submit(finished.idempotencyKey(),finished.input()).id());
            assertEquals(finished.result(),service.result(finished.job().id()));
            assertEquals("FAILED",service.submit(interrupted.idempotencyKey(),interrupted.input()).state());
        }
    }
    @Test void repeatedImportIsSafeAndChangedOrUnrelatedArchivesCannotOverwrite() {
        var d=complete("import-repeated");save(d);
        assertEquals(1,OptimizationArchiveImport.run(target,temp));
        assertEquals(1,OptimizationArchiveImport.run(target,temp));
        assertEquals(1,sql.queryForObject("SELECT COUNT(*) FROM optimization_archive_import",Integer.class));
        save(complete("import-another"));
        assertThrows(IllegalStateException.class,()->OptimizationArchiveImport.run(target,temp));
        assertEquals(List.of(d),target.load());
    }
    @Test void resultInsertFailureRollsBackWholeBatchAndCanRetryWithoutChangingSource()throws Exception {
        var d=complete("import-rollback");save(d);
        byte[] before=Files.readAllBytes(temp.resolve(d.job().id()+".json"));
        sql.execute("ALTER TABLE optimization_result ADD CONSTRAINT reject_import CHECK(token>0)");
        assertThrows(RuntimeException.class,()->OptimizationArchiveImport.run(target,temp));
        for(String table:List.of("optimization_job","optimization_attempt","optimization_result","optimization_archive_import","optimization_archive_entry"))
            assertEquals(0,sql.queryForObject("SELECT COUNT(*) FROM "+table,Integer.class),table);
        assertArrayEquals(before,Files.readAllBytes(temp.resolve(d.job().id()+".json")));
        sql.execute("ALTER TABLE optimization_result DROP CONSTRAINT reject_import");
        assertEquals(1,OptimizationArchiveImport.run(target,temp));
    }
    @Test void rejectsLiveSourceMissingDirectoryAndTamperedInputBeforeDatabaseWrites()throws Exception {
        var d=complete("import-validate");save(d);
        try(var live=new FileOptimizationJobStore(temp)) {
            assertThrows(IllegalStateException.class,()->OptimizationArchiveImport.run(target,temp));
        }
        assertThrows(IllegalArgumentException.class,()->OptimizationArchiveImport.run(target,temp.resolve("missing")));
        assertFalse(Files.exists(temp.resolve("missing")));
        var invalid=new StoredOptimizationJob(d.idempotencyKey(),request("crosscut",2,10,false),d.job(),d.result());
        save(invalid);
        assertThrows(IllegalArgumentException.class,()->OptimizationArchiveImport.run(target,temp));
        assertTrue(target.load().isEmpty());
    }
    @Test void duplicateKeysRejectWholeSourceAndNonemptyTargetIsPreserved() {
        var first=complete("duplicate-key");var second=complete("duplicate-key");save(first,second);
        assertThrows(IllegalArgumentException.class,()->OptimizationArchiveImport.run(target,temp));
        assertTrue(target.load().isEmpty());
        var another=queued("existing-database");target.configure(1,1,100);target.submitOrGet(another);
        assertEquals(another,target.find(another.job().id()));
        assertThrows(IllegalArgumentException.class,()->OptimizationArchiveImport.run(target,temp));
        assertEquals(List.of(another),target.load());
    }
    @Test void validArchiveCannotOverwriteExistingUnrelatedDatabase() {
        save(complete("valid-source-key"));
        var existing=queued("target-existing-key");target.configure(1,1,100);target.submitOrGet(existing);
        assertThrows(IllegalStateException.class,()->OptimizationArchiveImport.run(target,temp));
        assertEquals(List.of(existing),target.load());
        assertEquals(0,sql.queryForObject("SELECT COUNT(*) FROM optimization_archive_import",Integer.class));
    }
    Path saveCopy(String name,StoredOptimizationJob document) {
        var path=temp.resolve(name);
        try(var store=new FileOptimizationJobStore(path)){store.save(document);}
        return path;
    }
    List<Object> raceImports(Path first,Path second)throws Exception {
        var pool=Executors.newFixedThreadPool(2);var start=new CountDownLatch(1);
        try {
            var futures=new ArrayList<Future<Object>>();
            for(var path:List.of(first,second))futures.add(pool.submit(()->{
                start.await();
                try{return OptimizationArchiveImport.run(new JdbcOptimizationJobStore(source),path);}
                catch(IllegalStateException conflict){return conflict;}
            }));
            start.countDown();
            return List.of(futures.get(0).get(10,TimeUnit.SECONDS),futures.get(1).get(10,TimeUnit.SECONDS));
        } finally {pool.shutdownNow();}
    }
    @Test void concurrentCopiesOfSameArchiveCommitExactlyOnce()throws Exception {
        var document=complete("concurrent-same-key");
        assertEquals(List.of(1,1),raceImports(saveCopy("a",document),saveCopy("b",document)));
        for(String table:List.of("optimization_job","optimization_attempt","optimization_result","optimization_archive_import","optimization_archive_entry"))
            assertEquals(1,sql.queryForObject("SELECT COUNT(*) FROM "+table,Integer.class),table);
    }
    @Test void concurrentDifferentArchivesCannotMixPartialData()throws Exception {
        var results=raceImports(saveCopy("a",complete("concurrent-key-a")),saveCopy("b",complete("concurrent-key-b")));
        assertEquals(1,results.stream().filter(Integer.class::isInstance).count());
        assertEquals(1,results.stream().filter(IllegalStateException.class::isInstance).count());
        for(String table:List.of("optimization_job","optimization_attempt","optimization_result","optimization_archive_import","optimization_archive_entry"))
            assertEquals(1,sql.queryForObject("SELECT COUNT(*) FROM "+table,Integer.class),table);
    }
}
