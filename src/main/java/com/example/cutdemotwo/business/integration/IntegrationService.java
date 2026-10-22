package com.example.cutdemotwo.business.integration;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.*;
import com.example.cutdemotwo.business.model.IntegrationProgress.Attempt;
import com.example.cutdemotwo.persistence.IntegrationDeliveryStore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Ordered at-least-once pull delivery; external application of facts must deduplicate event IDs. */
@Service
public class IntegrationService {
    private final RemnantService inventory;
    private final IntegrationDeliveryStore store;
    private final boolean enabled;
    private final String consumer;
    private final byte[] credential;
    private final long leaseMillis;
    public IntegrationService(RemnantService inventory,IntegrationDeliveryStore store,
            @Value("${cutdemo.integration.enabled:false}") boolean enabled,
            @Value("${cutdemo.integration.consumer:external-inventory}") String consumer,
            @Value("${cutdemo.integration.token:}") String token,
            @Value("${cutdemo.integration.lease-seconds:60}") int leaseSeconds) {
        if(!consumer.matches("[A-Za-z0-9_-]{1,128}") || leaseSeconds<1 || leaseSeconds>600)
            throw new IllegalArgumentException("无效的集成方或租约配置");
        if(enabled && (token==null || token.length()<32 || token.isBlank()))
            throw new IllegalArgumentException("开启集成必须配置至少 32 字符的服务凭据");
        this.inventory=inventory;this.store=store;this.enabled=enabled;this.consumer=consumer;
        credential=(token==null?"":token).getBytes(StandardCharsets.UTF_8);leaseMillis=leaseSeconds*1000L;
    }
    public void authenticate(String header) {
        if(!enabled)throw failure("INTEGRATION_DISABLED","外部库存事件接口尚未启用",503,false);
        if(header==null || header.length()>8192 || !header.startsWith("Bearer ")
                || !MessageDigest.isEqual(credential,header.substring(7).getBytes(StandardCharsets.UTF_8)))
            throw failure("UNAUTHORIZED","需要有效的集成服务凭据",401,false);
    }
    public record Claim(String requestId,String retryOf) {}
    public record Acknowledgement(String token,String status,String externalReceipt,String reason) {}
    public record Delivery(String eventId,long sequence,String state,int attempt,long expiresAt,String externalReceipt,String reason) {}
    public record Lease(String consumer,String state,Attempt attempt,InventoryEvent event) {}
    public record Page(String consumer,long acknowledgedThrough,List<Delivery> items,long nextCursor,boolean hasMore) {}

    public Page list(long after,int limit) {
        if(after<0 || limit<1 || limit>100)throw invalid("after 必须非负，limit 必须为 1–100");
        // Read progress before inventory: a concurrently appended event cannot make this snapshot appear truncated.
        var progress=store.read(consumer);var events=inventory.integrationEvents();validateStream(progress,events);
        var page=events.stream().filter(e->e.sequence()>after).limit(limit).toList();
        var items=page.stream().map(e->{var a=last(progress,e.id());return new Delivery(e.id(),e.sequence(),
                a==null?"PENDING":"LEASED".equals(a.state())&&a.expiresAt()<=store.now()?"RETRYABLE":a.state(),
                a==null?0:a.number(),a==null?0:a.expiresAt(),a==null?null:a.externalReceipt(),a==null?null:a.reason());}).toList();
        long next=page.isEmpty()?after:page.get(page.size()-1).sequence();
        return new Page(consumer,progress.acknowledgedThrough(),items,next,events.stream().anyMatch(e->e.sequence()>next));
    }
    public Lease claim(Claim command) {
        if(command==null || command.requestId()==null || !command.requestId().matches("[A-Za-z0-9_-]{1,128}"))
            throw invalid("requestId 必须为 1–128 位字母、数字、下划线或短横线");
        if(command.retryOf()!=null && !command.retryOf().matches("[0-9a-f-]{36}"))throw invalid("retryOf 必须是被拒绝尝试的令牌");
        return store.update(consumer,progress->{
            var events=inventory.integrationEvents();validateStream(progress,events);
            for(var old:progress.attempts())if(old.requestId().equals(command.requestId())) {
                if(!Objects.equals(old.retryOf(),command.retryOf()))throw conflict("IDEMPOTENCY_CONFLICT","同一 requestId 不能更改重试内容");
                return unchanged(progress,lease(old,events));
            }
            if(progress.acknowledgedThrough()>=events.size())return unchanged(progress,new Lease(consumer,"EMPTY",null,null));
            var event=events.get((int)progress.acknowledgedThrough());var previous=last(progress,event.id());long now=store.now();
            if(previous!=null && "LEASED".equals(previous.state()) && previous.expiresAt()>now)
                throw conflict("DELIVERY_BUSY","该事件已被领取；未知响应请使用原 requestId 重试");
            if(previous!=null && "REJECTED".equals(previous.state())) {
                if(!previous.token().equals(command.retryOf()))throw conflict("DELIVERY_REJECTED","请处理拒绝原因，再通过 retryOf 显式重试");
            }else if(command.retryOf()!=null)throw conflict("STALE_ATTEMPT","重试令牌不属于当前被拒绝的尝试");
            var attempt=new Attempt(command.requestId(),command.retryOf(),event.id(),event.sequence(),previous==null?1:previous.number()+1,
                    UUID.randomUUID().toString(),now+leaseMillis,"LEASED",null,null);
            var attempts=new ArrayList<>(progress.attempts());attempts.add(attempt);
            var updated=new IntegrationProgress(progress.version(),events.get(0).id(),progress.acknowledgedThrough(),attempts);
            return new IntegrationDeliveryStore.Change<>(updated,new Lease(consumer,"LEASED",attempt,event));
        });
    }
    public Delivery acknowledge(String eventId,Acknowledgement command) {
        if(command==null || command.token()==null || !command.token().matches("[0-9a-f-]{36}"))throw invalid("需要有效的领取令牌");
        boolean accepted="ACCEPTED".equals(command.status());
        if(!accepted && !"REJECTED".equals(command.status()))throw invalid("status 必须为 ACCEPTED 或 REJECTED");
        if(accepted){requireText(command.externalReceipt(),200,"外部凭证");if(command.reason()!=null)throw invalid("接受回执不能包含拒绝原因");}
        else {requireText(command.reason(),1000,"拒绝原因");if(command.externalReceipt()!=null)throw invalid("拒绝回执不能包含成功凭证");}
        return store.update(consumer,progress->{
            var events=inventory.integrationEvents();validateStream(progress,events);
            var found=progress.attempts().stream().filter(a->a.token().equals(command.token())&&a.eventId().equals(eventId)).findFirst()
                    .orElseThrow(()->conflict("STALE_ATTEMPT","领取令牌与事件不匹配"));
            String state=accepted?"ACKNOWLEDGED":"REJECTED";
            if(!"LEASED".equals(found.state())) {
                if(!found.state().equals(state) || !Objects.equals(found.externalReceipt(),command.externalReceipt())
                        || !Objects.equals(found.reason(),command.reason()))throw conflict("IDEMPOTENCY_CONFLICT","已记录的回执不可更改");
                return unchanged(progress,delivery(found));
            }
            if(!found.equals(last(progress,eventId)) || found.expiresAt()<=store.now()
                    || found.eventSequence()!=progress.acknowledgedThrough()+1)
                throw conflict("STALE_ATTEMPT","领取已过期或已被新的尝试替代，请重新读取投递状态");
            var updated=new Attempt(found.requestId(),found.retryOf(),found.eventId(),found.eventSequence(),found.number(),found.token(),
                    found.expiresAt(),state,command.externalReceipt(),command.reason());
            var attempts=new ArrayList<>(progress.attempts());attempts.set(attempts.indexOf(found),updated);
            var next=new IntegrationProgress(progress.version(),progress.streamId(),accepted?found.eventSequence():progress.acknowledgedThrough(),attempts);
            return new IntegrationDeliveryStore.Change<>(next,delivery(updated));
        });
    }
    private Lease lease(Attempt attempt,List<InventoryEvent> events){
        String state="LEASED".equals(attempt.state())&&attempt.expiresAt()<=store.now()?"EXPIRED":attempt.state();
        return new Lease(consumer,state,attempt,events.get((int)attempt.eventSequence()-1));
    }
    private static Delivery delivery(Attempt a){return new Delivery(a.eventId(),a.eventSequence(),a.state(),a.number(),a.expiresAt(),a.externalReceipt(),a.reason());}
    private static Attempt last(IntegrationProgress state,String eventId){
        for(int i=state.attempts().size()-1;i>=0;i--)if(state.attempts().get(i).eventId().equals(eventId))return state.attempts().get(i);
        return null;
    }
    private static void validateStream(IntegrationProgress state,List<InventoryEvent> events){
        if(state.streamId().isEmpty() && state.attempts().isEmpty() && state.acknowledgedThrough()==0)return;
        if(events.isEmpty() || !events.get(0).id().equals(state.streamId()) || state.acknowledgedThrough()>events.size()
                || state.attempts().stream().anyMatch(a->a.eventSequence()<1 || a.eventSequence()>events.size()
                    || !events.get((int)a.eventSequence()-1).id().equals(a.eventId())))
            throw conflict("STREAM_MISMATCH","库存事件与外部确认记录不一致，需对账后恢复，不能自动跳过或重发历史");
    }
    private static void requireText(String s,int max,String field){if(s==null || s.isBlank() || s.length()>max)throw invalid(field+"不能为空且最多 "+max+" 字符");}
    private static <T> IntegrationDeliveryStore.Change<T> unchanged(IntegrationProgress state,T result){return new IntegrationDeliveryStore.Change<>(state,result);}
    private static Failure invalid(String message){return failure("INVALID_INPUT",message,400,false);}
    private static Failure conflict(String code,String message){return failure(code,message,409,false);}
    private static Failure failure(String code,String message,int status,boolean retryable){return new Failure(code,message,status,retryable);}
    public static final class Failure extends RuntimeException {
        public final String code;public final int status;public final boolean retryable;
        public Failure(String code,String message,int status,boolean retryable){super(message);this.code=code;this.status=status;this.retryable=retryable;}
    }
}
