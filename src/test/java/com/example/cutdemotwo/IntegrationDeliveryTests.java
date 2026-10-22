package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.integration.IntegrationService;
import com.example.cutdemotwo.business.model.IntegrationProgress;
import com.example.cutdemotwo.persistence.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Function;
import static org.junit.jupiter.api.Assertions.*;

class IntegrationDeliveryTests {
    @TempDir Path temp;
    static final String TOKEN="test-only-integration-token-0123456789";
    RemnantService inventory;FileInventoryStore stock;FileIntegrationDeliveryStore file;ClockStore clock;IntegrationService service;
    static class ClockStore implements IntegrationDeliveryStore {
        final IntegrationDeliveryStore delegate;long time=10000;
        ClockStore(IntegrationDeliveryStore delegate){this.delegate=delegate;}
        public <T>T update(String c,Function<IntegrationProgress,Change<T>> f){return delegate.update(c,f);}
        public IntegrationProgress read(String c){return delegate.read(c);}
        public long now(){return time;}
    }
    @BeforeEach void setup(){
        stock=new FileInventoryStore(temp.resolve("stock.json").toString());inventory=new RemnantService(stock,true);
        inventory.scrapRemnant("REM-202609-001","损坏");
        file=new FileIntegrationDeliveryStore(temp.resolve("deliveries"));clock=new ClockStore(file);service=service(inventory,clock);
    }
    @AfterEach void close(){if(file!=null)file.close();}
    IntegrationService service(RemnantService stock,IntegrationDeliveryStore store){return new IntegrationService(stock,store,true,"wms",TOKEN,1);}
    IntegrationService.Lease claim(String id){return service.claim(new IntegrationService.Claim(id,null));}
    IntegrationService.Acknowledgement accept(String token){return new IntegrationService.Acknowledgement(token,"ACCEPTED","WMS-001",null);}
    @Test void credentialsAreRequiredAndCannotBeEnabledByInput(){
        assertThrows(IntegrationService.Failure.class,()->service.authenticate(null));
        assertThrows(IntegrationService.Failure.class,()->service.authenticate("Bearer incorrect"));service.authenticate("Bearer "+TOKEN);
        var disabled=new IntegrationService(inventory,clock,false,"wms","",1);
        assertEquals(503,assertThrows(IntegrationService.Failure.class,()->disabled.authenticate("Bearer "+TOKEN)).status);
        assertThrows(IllegalArgumentException.class,()->new IntegrationService(inventory,clock,true,"wms","short",1));
    }
    @Test void claimAndAckReplayDoNotTouchInventory()throws Exception {
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));var lease=claim("claim-1");assertEquals(lease,claim("claim-1"));
        assertEquals("DELIVERY_BUSY",assertThrows(IntegrationService.Failure.class,()->claim("claim-2")).code);
        var ack=service.acknowledge(lease.event().id(),accept(lease.attempt().token()));assertEquals("ACKNOWLEDGED",ack.state());
        long version=file.read("wms").version();assertEquals(ack,service.acknowledge(lease.event().id(),accept(lease.attempt().token())));
        assertEquals(version,file.read("wms").version());assertEquals("EMPTY",claim("empty").state());
        assertEquals("IDEMPOTENCY_CONFLICT",assertThrows(IntegrationService.Failure.class,()->service.acknowledge(lease.event().id(),
                new IntegrationService.Acknowledgement(lease.attempt().token(),"ACCEPTED","other",null))).code);
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));assertEquals(1,service.list(0,10).acknowledgedThrough());
    }
    @Test void expiredLeaseCannotOverwriteNewAttempt(){
        var first=claim("one");clock.time+=1001;assertEquals("EXPIRED",claim("one").state());var second=claim("two");
        assertEquals(first.event(),second.event());assertNotEquals(first.attempt().token(),second.attempt().token());
        assertEquals("STALE_ATTEMPT",assertThrows(IntegrationService.Failure.class,()->service.acknowledge(first.event().id(),accept(first.attempt().token()))).code);
        assertEquals("ACKNOWLEDGED",service.acknowledge(second.event().id(),accept(second.attempt().token())).state());
    }
    @Test void rejectedEventBlocksLaterEventsUntilExplicitRetry(){
        var first=claim("one");var reject=new IntegrationService.Acknowledgement(first.attempt().token(),"REJECTED",null,"外部物料不匹配");
        service.acknowledge(first.event().id(),reject);
        assertEquals("DELIVERY_REJECTED",assertThrows(IntegrationService.Failure.class,()->claim("two")).code);
        var next=service.claim(new IntegrationService.Claim("two",first.attempt().token()));assertEquals(2,next.attempt().number());
        service.acknowledge(first.event().id(),reject);assertEquals("LEASED",service.list(0,10).items().get(0).state());
        service.acknowledge(next.event().id(),accept(next.attempt().token()));assertEquals(1,service.list(0,10).acknowledgedThrough());
    }
    @Test void restartPreservesUnknownResponseAndFileLockPreventsTwoOwners(){
        var first=claim("unknown-response");assertThrows(IllegalStateException.class,()->new FileIntegrationDeliveryStore(temp.resolve("deliveries")));
        file.close();file=null;
        try(var reopened=new FileIntegrationDeliveryStore(temp.resolve("deliveries"))){var clock2=new ClockStore(reopened);
            var restart=service(inventory,clock2);assertEquals(first,restart.claim(new IntegrationService.Claim("unknown-response",null)));
            restart.acknowledge(first.event().id(),accept(first.attempt().token()));
        }
    }
    @Test void restoredInventoryCannotSilentlyLosePreviouslyDeliveredFacts(){
        claim("one");var empty=new RemnantService(new FileInventoryStore(temp.resolve("other.json").toString()),false);
        assertEquals("STREAM_MISMATCH",assertThrows(IntegrationService.Failure.class,()->service(empty,clock).list(0,10)).code);
    }
    @Test void failedDeliverySaveLeavesEventPending(){
        var failing=new IntegrationDeliveryStore(){
            public IntegrationProgress read(String c){return file.read(c);}
            public long now(){return clock.now();}
            public <T>T update(String c,Function<IntegrationProgress,Change<T>> f){f.apply(read(c));throw new IllegalStateException("disk failure");}
        };
        assertThrows(IllegalStateException.class,()->service(inventory,failing).claim(new IntegrationService.Claim("first",null)));
        assertTrue(file.read("wms").attempts().isEmpty());assertEquals(1,claim("first").attempt().number());
    }
    @Test void jdbcConcurrentConsumersAndFailedAckPreserveExactlyOneActiveAttempt()throws Exception {
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var inventoryStore=new JdbcInventoryStore(ds);var inv=new RemnantService(inventoryStore,true);inv.scrapRemnant("REM-202609-001","损坏");
        long revision=inventoryStore.load().revision();var storeA=new JdbcIntegrationDeliveryStore(ds);var storeB=new JdbcIntegrationDeliveryStore(ds);
        var a=service(inv,storeA);var b=service(new RemnantService(new JdbcInventoryStore(ds),false),storeB);
        var pool=Executors.newFixedThreadPool(2);var start=new CountDownLatch(1);
        try {
            var tasks=List.of(pool.submit(()->{start.await();return a.claim(new IntegrationService.Claim("same-request",null));}),
                    pool.submit(()->{start.await();return b.claim(new IntegrationService.Claim("same-request",null));}));start.countDown();
            var first=tasks.get(0).get(5,TimeUnit.SECONDS);assertEquals(first,tasks.get(1).get(5,TimeUnit.SECONDS));assertEquals(1,storeA.read("wms").attempts().size());
            new org.springframework.jdbc.core.JdbcTemplate(ds).execute("ALTER TABLE integration_delivery ADD CONSTRAINT refuse_ack CHECK (data_json NOT LIKE '%ACKNOWLEDGED%')");
            assertThrows(org.springframework.dao.DataAccessException.class,()->a.acknowledge(first.event().id(),accept(first.attempt().token())));
            assertEquals(0,storeB.read("wms").acknowledgedThrough());assertEquals("LEASED",storeB.read("wms").attempts().get(0).state());
            assertEquals(revision,inventoryStore.load().revision());
        }finally{pool.shutdownNow();}
    }
}
