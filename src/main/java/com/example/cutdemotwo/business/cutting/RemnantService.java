package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.ExecutionOrder;
import com.example.cutdemotwo.business.model.InventoryLedgerEntry;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.InventoryEvent;
import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.business.model.CutReport;
import com.example.cutdemotwo.business.model.QualityDisposition;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.business.model.CuttingPlan;
import com.example.cutdemotwo.persistence.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

/**
 * 工业母卷与料头全生命周期档案服务 (Master Roll & Remnant Inventory Service)
 * 维护母卷物理规格、多道工序验布疵点、现场料头库存货架与代际派生血统
 */
@Service
public class RemnantService {

    private final Map<String, RemnantStock> remnantPool = new ConcurrentHashMap<>();
    private final Map<String, MotherRollInfo> motherRolls = new LinkedHashMap<>();
    private final AtomicInteger remnantSeq = new AtomicInteger(10);
    private final AtomicInteger defectSeq = new AtomicInteger(20);
    private final Map<String, Map<String, Object>> receipts = new LinkedHashMap<>();
    private final Map<String, CuttingTask> tasks = new LinkedHashMap<>();
    private final ObjectMapper json = new ObjectMapper();
    private final InventoryStore store;
    private final Map<String, CuttingPlan> plans = new LinkedHashMap<>();
    private final Map<String,ExecutionOrder> executions = new LinkedHashMap<>();
    private final Map<String,InventoryTransfer> transfers=new LinkedHashMap<>();
    private List<InventoryLedgerEntry> ledger = List.of();
    private List<InventoryEvent> outbox = List.of();
    private final Map<String,InventoryCount> counts=new LinkedHashMap<>();
    private long revision;
    private boolean accessing;
    private long operationTime;
    @Value("${cutdemo.measurement.tolerance-mm:5}")
    private double measurementToleranceMm = 5;

    public RemnantService(String statePath) { this(new FileInventoryStore(statePath), true); }

    @org.springframework.beans.factory.annotation.Autowired
    public RemnantService(InventoryStore store, @Value("${cutdemo.seed-demo-data:}") String seedDemo) {
        this(store, seedDemo.isBlank() ? !store.shared() : Boolean.parseBoolean(seedDemo));
        if (seedDemo.isBlank() ? !store.shared() : Boolean.parseBoolean(seedDemo)) prepareOrderDemoInventory();
    }

    public RemnantService(InventoryStore store, boolean seedDemo) {
        this.store = store;
        InventorySnapshot loaded = store.load();
        if (loaded != null) restore(loaded);
        else if (seedDemo) { initMotherRolls(); initSampleRemnants(); }
    }

    public synchronized Map<String, Integer> initializeDemoInventory() {
        return mutate("DEMO_RECEIPT",null,"SYSTEM_DEMO",() -> {
            if (!motherRolls.isEmpty() || !remnantPool.isEmpty() || !tasks.isEmpty() || !plans.isEmpty() || !receipts.isEmpty()) {
                throw new IllegalArgumentException("当前库已有业务数据，不能创建整套示例材料；请使用已有库存或单独准备演示库");
            }
            initMotherRolls();
            initSampleRemnants();
            appendOrderDemoInventory(orderDemoMaterials());
            motherRolls.values().forEach(roll -> roll.setStorageLocation("示例材料（非实物）"));
            remnantPool.values().forEach(remnant -> remnant.setLocation("示例料头（非实物）"));
            return Map.of("rolls", motherRolls.size(), "remnants", remnantPool.size());
        });
    }

    private record DemoMaterial(String fabricCode, String materialModel, double width, double sampleWidth, double sampleLength) {}

    private DemoMaterial[] orderDemoMaterials() {
        try (var input = new org.springframework.core.io.ClassPathResource("demo/order-materials.json").getInputStream()) {
            return json.readValue(input, DemoMaterial[].class);
        } catch (java.io.IOException error) { throw new java.io.UncheckedIOException("读取订单演示材料失败", error); }
    }

    /** Append fixtures only; a consumed or scrapped demo remnant is never replenished. */
    public synchronized Map<String, Integer> prepareOrderDemoInventory() {
        var materials = orderDemoMaterials();
        return mutate("DEMO_RECEIPT",null,"SYSTEM_DEMO",() -> appendOrderDemoInventory(materials));
    }

    private Map<String, Integer> appendOrderDemoInventory(DemoMaterial[] materials) {
        int rollsBefore = motherRolls.size(), remnantsBefore = remnantPool.size();
        var examples = new LinkedHashMap<String, double[]>();
        for (var material : materials) {
            String id = Set.of("893153", "893292").contains(material.fabricCode())
                    ? "ROLL-REAL-" + material.fabricCode() : "ROLL-DEMO-928-" + material.fabricCode();
            if (!motherRolls.containsKey(id)) {
                var roll = new MotherRollInfo(id, material.materialModel(), "DEMO-928-" + material.fabricCode(),
                        "9.28 订单演示", "布料 " + material.fabricCode(), "演示未标定", 0, "演示未标定",
                        material.width(), 100000, "9.28 演示预置（非实物）");
                roll.setInspector("演示预置");
                roll.setShrinkageRate(0);
                motherRolls.put(id, roll);
            }
            if (material.materialModel().equals(motherRolls.get(id).getRollModel()))
                examples.put(id, new double[]{material.sampleWidth(), material.sampleLength()});
        }
        for (String id : List.of("ROLL-2026-0920", "ROLL-2026-0921", "ROLL-2026-0922", "ROLL-DEMO-2D")) {
            var roll = motherRolls.get(id);
            if (roll != null) examples.put(id, new double[]{roll.getWidth(), 1200});
        }
        for (var entry : examples.entrySet()) {
            var roll = motherRolls.get(entry.getKey());
            double width = Math.min(roll.getWidth(), entry.getValue()[0] + 40), length = entry.getValue()[1] + 60;
            for (int variant = 1; variant <= 3; variant++) {
                String id = "DEMO-REM-" + roll.getRollId() + "-" + variant;
                if (remnantPool.containsKey(id)) continue;
                boolean defect = variant == 2;
                double w = variant == 3 ? Math.max(100, Math.floor(width / 3)) : variant == 2 ? roll.getWidth() : width;
                double l = variant == 2 ? length * 2 + 300 : length;
                var remnant = new RemnantStock(id, w, l, "演示预置料头（非实物）", roll.getRollModel(),
                        "AVAILABLE", roll.getRollId(), defect,
                        variant == 1 ? "演示预置：整片复用" : defect ? "演示预置：局部带疵，需避让" : "演示预置：窄条，展示规格不匹配");
                remnant.setQualityGrade(defect ? "GRADE_DEFECT" : "GRADE_A");
                remnant.setGeneration(1);
                if (defect) remnant.setDefects(new ArrayList<>(List.of(new Defect(1, 40, l - 180, 120, 120,
                        20, "STAIN", "演示污斑", 2, 2, "MANUAL_INSPECT", "MUST_AVOID", "演示预置疵点"))));
                remnantPool.put(id, remnant);
            }
        }
        return Map.of("rolls", motherRolls.size() - rollsBefore, "remnants", remnantPool.size() - remnantsBefore);
    }

    private InventorySnapshot snapshot() {
        return new InventorySnapshot(new ArrayList<>(motherRolls.values()), new ArrayList<>(remnantPool.values()),
                receipts, remnantSeq.get(), defectSeq.get(), tasks, plans, revision, executions, ledger, transfers, outbox, counts);
    }

    private void restore(InventorySnapshot snapshot) {
        motherRolls.clear(); snapshot.rolls().forEach(r -> motherRolls.put(r.getRollId(), r));
        remnantPool.clear(); snapshot.remnants().forEach(r -> remnantPool.put(r.getId(), r));
        receipts.clear(); receipts.putAll(snapshot.receipts());
        tasks.clear(); if (snapshot.tasks() != null) tasks.putAll(snapshot.tasks());
        plans.clear(); if (snapshot.plans() != null) plans.putAll(snapshot.plans());
        executions.clear();executions.putAll(snapshot.executions());
        ledger = snapshot.ledger();
        outbox = snapshot.outbox();
        counts.clear();counts.putAll(snapshot.counts());
        transfers.clear();transfers.putAll(snapshot.transfers());
        revision = snapshot.revision();
        remnantSeq.set(snapshot.remnantSeq()); defectSeq.set(snapshot.defectSeq());
    }

    /** One business command either persists every change or restores its entire before-image. */
    private <T> T mutate(java.util.function.Supplier<T> command) {
        return mutate("SYSTEM_UPDATE",null,"UNAUTHENTICATED_LOCAL",command);
    }

    private <T> T mutate(String eventType,String businessId,String actor,java.util.function.Supplier<T> command) {
        return mutate(eventType,businessId,actor,()->null,command);
    }

    /** A known immutable receipt is a read, even when its original inventory version is stale. */
    private <T> T mutate(String eventType,String businessId,String actor,java.util.function.Supplier<T> replay,
            java.util.function.Supplier<T> command) {
        refresh();
        T previous = replay.get();
        if (previous != null) return previous;
        operationTime = store.now();
        byte[] before = json.writeValueAsBytes(snapshot());
        restore(json.readValue(before, InventorySnapshot.class));
        accessing = true;
        try {
            T result = command.get();
            ledger = InventoryJournal.append(json.readValue(before,InventorySnapshot.class),snapshot(),
                    eventType,businessId,actor,operationTime);
            outbox = InventoryEvent.append(outbox,json.readValue(before,InventorySnapshot.class).ledger().size(),
                    ledger,eventType,businessId,operationTime,revision+1);
            save();
            return result;
        } catch (RuntimeException error) {
            restore(json.readValue(before, InventorySnapshot.class));
            throw error;
        } finally { accessing = false; }
    }

    /** Committed immutable facts; reads and external receipts never mutate inventory. */
    public synchronized List<InventoryEvent> integrationEvents() { return read(() -> outbox); }

    private void refresh() {
        if (!accessing && store.shared()) {
            InventorySnapshot latest = store.load();
            if (latest != null && latest.revision() != revision) restore(latest);
        }
    }

    private <T> T read(java.util.function.Supplier<T> query) {
        if (accessing) return query.get();
        refresh(); operationTime = store.now(); accessing = true;
        try { return query.get(); } finally { accessing = false; }
    }

    public synchronized Map<String,Object> inventoryLedger(String aggregateType,String aggregateId,long after,int limit) {
        if(after<0 || limit<1 || limit>500)throw new IllegalArgumentException("流水游标不得为负，分页大小为 1–500");
        return read(() -> {
            var page=ledger.stream().filter(e -> e.sequence()>after
                    && (aggregateType==null || aggregateType.equals(e.aggregateType()))
                    && (aggregateId==null || aggregateId.equals(e.aggregateId()))).limit(limit+1L).toList();
            var items=page.stream().limit(limit).toList();
            return Map.of("items",items,"hasMore",page.size()>limit,
                    "nextCursor",items.isEmpty()?after:items.get(items.size()-1).sequence(),"revision",revision);
        });
    }

    public synchronized Map<String,Object> transferOptions() {
        return read(()->{
            var materials=new ArrayList<Map<String,Object>>();
            for(var roll:motherRolls.values())materials.add(transferOption("roll",roll.getRollId(),roll.getStorageLocation(),roll.getRollModel()));
            for(var remnant:remnantPool.values())materials.add(transferOption("remnant",remnant.getId(),remnant.getLocation(),remnant.getMaterialBatch()));
            materials.sort(Comparator.comparing(row->row.get("type")+"/"+row.get("id")));
            return Map.of("revision",revision,"materials",materials);
        });
    }
    private Map<String,Object> transferOption(String type,String id,String location,String model) {
        String reason=transferBlock(type,id);
        return Map.of("type",type,"id",id,"location",Objects.toString(location,""),"materialModel",Objects.toString(model,""),
                "allowed",reason.isEmpty(),"reason",reason);
    }
    private String transferBlock(String type,String id) {
        if("roll".equals(type)) {
            var roll=motherRolls.get(id);
            if(roll==null)return "母卷不存在";
            if(roll.getCurrentRemainingLength()<=0)return "母卷已用尽";
        } else if("remnant".equals(type)) {
            var remnant=remnantPool.get(id);
            if(remnant==null)return "料头不存在";
            if(!Set.of("AVAILABLE","QUARANTINED").contains(remnant.getStatus()))return "料头已不在库";
        } else return "材料类型必须为 roll 或 remnant";
        if(executions.values().stream().anyMatch(e->e.materialType().equals(type)&&e.materialId().equals(id)&&e.reserves(operationTime)))
            return "材料已被执行单预约或正在加工";
        return "";
    }
    public synchronized List<InventoryTransfer> inventoryTransfers() {
        return read(()->transfers.values().stream().sorted(Comparator.comparingLong(InventoryTransfer::inventoryRevision).reversed()).toList());
    }
    public synchronized InventoryTransfer transferInventory(String key,InventoryTransfer.Command command) {
        if(key==null || key.isBlank() || key.length()>128 || command==null || command.expectedRevision()<0
                || command.destination()==null || command.destination().isBlank() || command.destination().length()>120
                || command.reason()==null || command.reason().isBlank() || command.reason().length()>500
                || command.operator()==null || command.operator().isBlank() || command.operator().length()>100
                || command.materials()==null || command.materials().isEmpty() || command.materials().size()>100)
            throw new IllegalArgumentException("请填写有效库存版本、目标库位、移库原因、经办人和 1–100 项材料");
        String documentId=UUID.randomUUID().toString();
        return mutate("INVENTORY_TRANSFER",documentId,"DECLARED:"+command.operator(),()->{
            for(var previous:transfers.values())if(previous.idempotencyKey().equals(key)) {
                if(!previous.command().equals(command))throw new InventoryConflictException("同一幂等键已用于其他移库内容");
                return previous;
            }
            if(command.expectedRevision()!=revision)throw new InventoryConflictException("库存版本已变化，请刷新材料后重新核对移库单");
            var identities=new HashSet<String>();var lines=new ArrayList<InventoryTransfer.Line>();
            for(var material:command.materials()) {
                if(material==null || material.id()==null || material.id().isBlank() || material.type()==null)
                    throw new IllegalArgumentException("材料类型和编号不能为空");
                if(!identities.add(material.type()+"/"+material.id()))throw new IllegalArgumentException("同一材料不能重复移库");
                String blocked=transferBlock(material.type(),material.id());
                if(!blocked.isEmpty())throw new InventoryConflictException(material.id()+"："+blocked);
                String old="roll".equals(material.type())?motherRolls.get(material.id()).getStorageLocation():remnantPool.get(material.id()).getLocation();
                if(command.destination().equals(Objects.toString(old,"")))throw new IllegalArgumentException("目标库位与当前库位相同："+material.id());
                lines.add(new InventoryTransfer.Line(material.type(),material.id(),Objects.toString(old,""),command.destination()));
            }
            for(var line:lines) {
                if("roll".equals(line.type()))motherRolls.get(line.id()).setStorageLocation(line.toLocation());
                else remnantPool.get(line.id()).setLocation(line.toLocation());
            }
            var document=new InventoryTransfer(documentId,key,command,operationTime,revision+1,lines);
            transfers.put(document.id(),document);return document;
        });
    }

    public synchronized List<InventoryCount> inventoryCounts() {
        return read(()->counts.values().stream().sorted(Comparator.comparingLong(InventoryCount::inventoryRevision).reversed()).toList());
    }
    private long countRevision(String type,String id) {
        return counts.values().stream().filter(c->c.lines().stream().anyMatch(l->type.equals(l.type())&&id.equals(l.id())))
                .mapToLong(InventoryCount::inventoryRevision).max().orElse(0);
    }
    private String countBlock(String type,String id) {
        if("roll".equals(type)) {if(!motherRolls.containsKey(id))return "母卷不存在";}
        else if("remnant".equals(type)) {
            var r=remnantPool.get(id);if(r==null)return "料头不存在";
            if(!Set.of("AVAILABLE","QUARANTINED","LOST").contains(r.getStatus()))return "仅在库、隔离或盘亏料头可盘点";
        } else return "材料类型必须为 roll 或 remnant";
        if(executions.values().stream().anyMatch(e->e.materialType().equals(type)&&e.materialId().equals(id)&&e.reserves(operationTime)))
            return "材料已被执行单预约或正在加工";
        return "";
    }
    public synchronized Map<String,Object> countOptions() {
        return read(()->{
            var materials=new ArrayList<Map<String,Object>>();
            for(var r:motherRolls.values())materials.add(countOption("roll",r.getRollId(),r.getWidth(),r.getCurrentRemainingLength(),
                    r.getInspectionStatus(),r.getStorageLocation(),r.getRollModel()));
            for(var r:remnantPool.values())materials.add(countOption("remnant",r.getId(),r.getWidth(),r.getLength(),r.getStatus(),r.getLocation(),r.getMaterialBatch()));
            materials.sort(Comparator.comparing(row->row.get("type")+"/"+row.get("id")));
            return Map.of("revision",revision,"materials",materials);
        });
    }
    private Map<String,Object> countOption(String type,String id,double width,double length,String status,String location,String model) {
        String reason=countBlock(type,id);
        return Map.of("type",type,"id",id,"width",width,"length",length,"status",Objects.toString(status,""),
                "location",Objects.toString(location,""),"materialModel",Objects.toString(model,""),"allowed",reason.isEmpty(),"reason",reason);
    }
    public synchronized InventoryCount countInventory(String key,InventoryCount.Command command) {
        if(key==null || !key.matches("[A-Za-z0-9._:-]{8,128}") || command==null || command.expectedRevision()<0
                || command.reason()==null || command.reason().isBlank() || command.reason().length()>500
                || command.operator()==null || command.operator().isBlank() || command.operator().length()>100
                || command.materials()==null || command.materials().isEmpty() || command.materials().size()>100)
            throw new IllegalArgumentException("请填写有效版本、原因、经办人和 1–100 项实测材料");
        String id=UUID.randomUUID().toString();
        return mutate("INVENTORY_COUNT",id,"DECLARED:"+command.operator(),()->{
            for(var previous:counts.values())if(previous.idempotencyKey().equals(key)) {
                if(!previous.command().equals(command))throw new InventoryConflictException("同一幂等键不能修改盘点内容");
                return previous;
            }
            return null;
        },()->{
            if(command.expectedRevision()!=revision)throw new InventoryConflictException("库存版本已变化，请重新核对账面值与实测值");
            var identities=new HashSet<String>();var lines=new ArrayList<InventoryCount.Line>();
            for(var observation:command.materials()) {
                if(observation==null || observation.type()==null || !Set.of("roll","remnant").contains(observation.type()) || observation.id()==null || observation.id().isBlank()
                        || !identities.add(observation.type()+"/"+observation.id()))throw new IllegalArgumentException("材料身份缺失或重复");
                String blocked=countBlock(observation.type(),observation.id());
                if(!blocked.isEmpty())throw new InventoryConflictException(observation.id()+"："+blocked);
                double w=observation.width(),l=observation.length();
                if(!Double.isFinite(w) || !Double.isFinite(l) || w<=0 || w>1e9 || l<0 || l>1e9
                        || (observation.present()?l<=0:l!=0))throw new IllegalArgumentException("实测宽度必须为正数，在场长度为正数，未见实物长度为零；尺寸不超过 10 亿 mm");
                if("roll".equals(observation.type())) {
                    var r=motherRolls.get(observation.id());double total=r.getUsedLength()+l;
                    if(w!=r.getWidth())throw new IllegalArgumentException("母卷盘点只校正未切余长，不能更改幅宽");
                    if(!Double.isFinite(total) || total>1e9 || r.getUsedLength()<0)throw new IllegalArgumentException("母卷累计长度无效");
                    for(var report:receipts.values())if(!"REVERSED".equals(report.get("status")) && "roll".equals(report.get("feedPortType")) && r.getRollId().equals(report.get("rollId"))
                            && report.get("windowStartY") instanceof Number start && report.get("actualCutLen") instanceof Number used
                            && start.doubleValue()+used.doubleValue()>total+.001)
                        throw new InventoryConflictException("实测边界覆盖历史已切区域，请先核查跳段报工与材料坐标");
                    if(observation.present())checkCountDefects(r.getDefects(),w,total);
                    lines.add(new InventoryCount.Line("roll",r.getRollId(),w,r.getCurrentRemainingLength(),r.getInspectionStatus(),w,l,
                            r.getInspectionStatus(),w*(l-r.getCurrentRemainingLength())/1e6,r.getUsedLength(),r.getTotalLength(),total));
                } else {
                    var r=remnantPool.get(observation.id());
                    if(observation.present())checkCountDefects(r.getDefects(),w,l);
                    else if(w!=r.getWidth())throw new IllegalArgumentException("未见实物时保留原幅宽，不能凭空修改几何");
                    String next=!observation.present()?"LOST":"LOST".equals(r.getStatus())?"QUARANTINED":r.getStatus();
                    double oldArea="LOST".equals(r.getStatus())?0:r.getArea();
                    lines.add(new InventoryCount.Line("remnant",r.getId(),r.getWidth(),r.getLength(),r.getStatus(),w,l,next,
                            (observation.present()?w*l/1e6:0)-oldArea,0,0,0));
                }
            }
            for(var line:lines) {
                if("roll".equals(line.type())) {var r=motherRolls.get(line.id());r.setCurrentRemainingLength(line.measuredLength());r.setTotalLength(line.afterTotalLength());}
                else {var r=remnantPool.get(line.id());if(!"LOST".equals(line.afterStatus())){r.setWidth(line.measuredWidth());r.setLength(line.measuredLength());}r.setStatus(line.afterStatus());}
            }
            var document=new InventoryCount(id,key,command,operationTime,revision+1,lines);counts.put(id,document);return document;
        });
    }
    private void checkCountDefects(List<Defect> defects,double width,double length) {
        if(defects!=null && defects.stream().anyMatch(d->d.getX()+d.getW()>width+.001 || d.getY()+d.getH()>length+.001))
            throw new InventoryConflictException("实测边界小于已登记疵点范围，请核查测量与疵点坐标；盘点不会截掉疵点历史");
    }

    public synchronized Map<String,Object> reconcileInventory() {
        return read(() -> InventoryJournal.reconcile(snapshot()));
    }

    public synchronized ExecutionOrder createExecution(String key,ExecutionOrder.Create input) {
        if(key==null || !key.matches("[A-Za-z0-9._:-]{8,128}") || input==null || input.planId()==null
                || input.station()==null || input.station().isBlank() || input.station().length()>100)
            throw new IllegalArgumentException("请提供有效幂等键、方案和 1–100 字工位");
        return mutate(()->{
            for(var e:executions.values())if(e.idempotencyKey().equals(key)) {
                if(!e.planId().equals(input.planId()) || !e.station().equals(input.station()))
                    throw new InventoryConflictException("同一幂等键已用于其他执行单内容");
                return e;
            }
            var plan=plans.get(input.planId());
            if(plan==null || !"PENDING".equals(plan.status()) || plan.request().getTaskId()==null || plan.result().getPieces().isEmpty())
                throw new IllegalArgumentException("执行单必须关联有裁片且尚未报工的任务方案");
            if(executions.values().stream().anyMatch(e->e.planId().equals(plan.id())
                    && !Set.of("CANCELLED","EXPIRED").contains(e.effectiveState(operationTime))))
                throw new InventoryConflictException("该方案已有执行单，请查询已有执行单");
            var counts=new LinkedHashMap<String,Integer>();
            plan.result().getPieces().forEach(piece->{
                if(piece.getDemandId()==null)throw new IllegalArgumentException("裁片缺少需求身份");
                counts.merge(String.valueOf(piece.getDemandId()),1,Integer::sum);
            });
            var request=plan.request();boolean remnant="remnant".equals(request.getFeedPortType());
            var e=new ExecutionOrder(UUID.randomUUID().toString(),key,plan.id(),request.getTaskId(),input.station(),
                    remnant?"remnant":"roll",remnant?request.getSourceRemnantId():request.getRollId(),counts,
                    "DRAFT",1,operationTime,null,List.of());
            executions.put(e.id(),e);return e;
        });
    }

    public synchronized List<Map<String,Object>> executionOrders(String taskId) {
        return read(()->executions.values().stream().filter(e->taskId==null || taskId.equals(e.taskId()))
                .sorted(Comparator.comparingLong(ExecutionOrder::createdAt).thenComparing(ExecutionOrder::id)).map(this::executionView).toList());
    }
    public synchronized Map<String,Object> executionOrder(String id) { return read(()->executionView(requiredExecution(id))); }
    private Map<String,Object> executionView(ExecutionOrder e) {
        String effective=e.effectiveState(operationTime);
        var actions=new LinkedHashMap<String,Object>();
        for(String action:List.of("release","start","cancel","report")) {
            boolean allowed=switch(action) {
                case "release" -> Set.of("DRAFT","EXPIRED").contains(effective);
                case "start" -> "RELEASED".equals(effective);
                case "cancel" -> Set.of("DRAFT","RELEASED","EXPIRED").contains(effective);
                default -> "RUNNING".equals(effective);
            };
            String reason=allowed?"":"当前执行状态不支持此操作";
            if(allowed && Set.of("release","start").contains(action)) {
                try {validateExecutionRelease(e);}
                catch(IllegalArgumentException | InventoryConflictException error) {allowed=false;reason=error.getMessage();}
            }
            actions.put(action,Map.of("allowed",allowed,"reason",reason));
        }
        return Map.of("execution",e,"effectiveState",effective,"reservationActive",e.reserves(operationTime),"allowedActions",actions);
    }
    private ExecutionOrder requiredExecution(String id) {
        var e=executions.get(id);if(e==null)throw new IllegalArgumentException("执行单不存在");return e;
    }
    public synchronized ExecutionOrder changeExecution(String id,String action,ExecutionOrder.Command command) {
        if(command==null || command.operationId()==null || !command.operationId().matches("[A-Za-z0-9._:-]{8,128}")
                || command.expectedVersion()<1 || command.reason()==null || command.reason().length()>500)
            throw new IllegalArgumentException("请提供操作幂等编号、执行单版本与不超过 500 字原因");
        if(!Set.of("release","start","cancel").contains(action))throw new IllegalArgumentException("未知执行单操作");
        if("release".equals(action)?command.reservationSeconds()<1 || command.reservationSeconds()>86400:command.reservationSeconds()!=0)
            throw new IllegalArgumentException("下达预约时长须为 1–86400 秒，其他操作填 0");
        if("cancel".equals(action) && command.reason().isBlank())throw new IllegalArgumentException("取消须填写原因");
        return mutate(()->{
            var e=requiredExecution(id);
            for(var event:e.events())if(event.operationId().equals(command.operationId())) {
                if(!event.action().equals(action) || event.expectedVersion()!=command.expectedVersion()
                        || event.reservationSeconds()!=command.reservationSeconds() || !event.reason().equals(command.reason()))
                    throw new InventoryConflictException("操作编号已绑定不同执行命令");
                return e;
            }
            if(e.version()!=command.expectedVersion())throw new InventoryConflictException("执行单版本已变化，请刷新");
            long now=operationTime;String state=e.effectiveState(now);ExecutionOrder updated;
            switch(action) {
                case "release" -> {
                    if(!Set.of("DRAFT","EXPIRED").contains(state))throw new InventoryConflictException("只有待下达或预约已过期的执行单可以下达");
                    validateExecutionRelease(e);
                    updated=e.transition("RELEASED",now+command.reservationSeconds()*1000L,action,command,now);
                }
                case "start" -> {
                    if(!"RELEASED".equals(state))throw new InventoryConflictException("执行单尚未下达、预约已过期或已开工");
                    validateExecutionRelease(e);
                    updated=e.transition("RUNNING",null,action,command,now);
                }
                default -> {
                    if(!Set.of("DRAFT","RELEASED","EXPIRED").contains(state))throw new InventoryConflictException("已开工不能取消或删除；请按实际产出报工");
                    updated=e.transition("CANCELLED",null,action,command,now);
                }
            }
            executions.put(id,updated);return updated;
        });
    }
    private void validateExecutionRelease(ExecutionOrder execution) {
        if(executions.values().stream().anyMatch(e->!e.id().equals(execution.id()) && e.planId().equals(execution.planId()) && e.reserves(operationTime)))
            throw new InventoryConflictException("同一方案已有其他有效执行单");
        var plan=plans.get(execution.planId());
        if(plan==null || !"PENDING".equals(plan.status()))throw new InventoryConflictException("方案已失效或报工");
        // Read-side action advice must never normalize the archived request in place.
        prepareTaskSolveInternal(json.readValue(json.writeValueAsBytes(plan.request()),SolveRequest.class));
        if(!Objects.equals(plan.baseline(),materialFingerprintInternal(plan.request())))throw new InventoryConflictException("方案材料快照已变化，请重新排料");
        ensureMaterialNotReserved(execution.materialType(),execution.materialId(),execution.planId());
        if("roll".equals(execution.materialType()) && !"PASSED".equals(motherRolls.get(execution.materialId()).getInspectionStatus()))
            throw new InventoryConflictException("母卷尚未检验合格，不能下达");
        var completed=completedQuantitiesInternal(execution.taskId());var reserved=reservedQuantities(execution.taskId(),execution.planId());
        var task=tasks.get(execution.taskId());
        for(var entry:execution.demandQuantities().entrySet()) {
            var line=task.demands().stream().filter(d->String.valueOf(d.id()).equals(entry.getKey())).findFirst()
                    .orElseThrow(()->new InventoryConflictException("执行单需求已失效"));
            if(entry.getValue()>line.quantity()-completed.getOrDefault(entry.getKey(),0)-reserved.getOrDefault(entry.getKey(),0))
                throw new InventoryConflictException("需求已被其他执行单占用或已完成，不能重复下达");
        }
    }
    public synchronized Map<String,Object> reportExecution(String id,CutReport report) {
        return mutate("CUT_REPORT",report == null ? null : report.planId(),"UNAUTHENTICATED_LOCAL",()->{
            var e=requiredExecution(id);
            if(report==null || !e.planId().equals(report.planId()))throw new IllegalArgumentException("报工方案与执行单不一致");
            if(!Set.of("RUNNING","REPORTED").contains(e.state()))throw new InventoryConflictException("执行单尚未开工或已终止");
            return confirmPlanInternal(report);
        });
    }
    private Map<String,Integer> reservedQuantities(String taskId,String exceptPlan) {
        var counts=new LinkedHashMap<String,Integer>();long now=operationTime;
        executions.values().stream().filter(e->Objects.equals(e.taskId(),taskId) && !Objects.equals(e.planId(),exceptPlan) && e.reserves(now))
                .forEach(e->e.demandQuantities().forEach((id,n)->counts.merge(id,n,Integer::sum)));
        return counts;
    }
    private void ensureMaterialNotReserved(String type,String id,String exceptPlan) {
        if(executions.values().stream().anyMatch(e->e.materialType().equals(type) && Objects.equals(e.materialId(),id)
                && !Objects.equals(e.planId(),exceptPlan) && e.reserves(operationTime)))
            throw new InventoryConflictException("材料已被其他执行单预约或正在加工，请先处理原执行单");
    }
    private void ensurePlanNotExecuting(String planId) {
        if(executions.values().stream().anyMatch(e->e.planId().equals(planId) && e.reserves(operationTime)))
            throw new InventoryConflictException("方案已有有效执行单，请先取消未开工执行单；已开工须实际报工");
    }
    private void validateExecutionReport(SolveRequest request,SolveResponse result,CutReport report) {
        boolean remnant="remnant".equalsIgnoreCase(request.getFeedPortType());
        ensureMaterialNotReserved(remnant?"remnant":"roll",remnant?request.getSourceRemnantId():request.getRollId(),report.planId());
        var execution=executions.values().stream().filter(e->e.planId().equals(report.planId()))
                .max(Comparator.comparing((ExecutionOrder e)->"RUNNING".equals(e.state())).thenComparingLong(ExecutionOrder::createdAt));
        if(execution.isPresent()) {
            var e=execution.get();
            if(!"RUNNING".equals(e.state()))throw new InventoryConflictException("请通过已下达执行单开工后报工");
            var original=plans.get(e.planId());
            if(original==null || !json.writeValueAsString(request).equals(json.writeValueAsString(original.request()))
                    || !json.writeValueAsString(result).equals(json.writeValueAsString(original.result())))
                throw new InventoryConflictException("执行报工不得替换已下达方案内容");
        }
    }
    private void finishExecution(String planId,String state) {
        executions.replaceAll((id,e)->e.planId().equals(planId) && Set.of("RUNNING","REPORTED").contains(e.state())
                ?e.transition(state,null,state.toLowerCase(),new ExecutionOrder.Command("system-"+state.toLowerCase()+"-"+planId,e.version(),0,"报工事务"),operationTime):e);
    }
    private void verifyReportReplay(Map<String,Object> receipt,CutReport report) {
        Object hash=receipt.get("reportContent");
        if(hash!=null && !hash.equals(json.writeValueAsString(report)))throw new InventoryConflictException("该方案已报工，重复提交的内容不同");
    }

    public synchronized String materialFingerprint(SolveRequest request) {
        return read(() -> materialFingerprintInternal(request));
    }

    private String materialFingerprintInternal(SolveRequest request) {
        if ("remnant".equalsIgnoreCase(request.getFeedPortType())) {
            RemnantStock item = remnantPool.get(request.getSourceRemnantId());
            if (item == null) throw new IllegalArgumentException("料头不存在，请重新选料");
            return countedFingerprint("remnant",item.getId(),Arrays.asList(item.getId(), item.getWidth(), item.getLength(),
                    item.getMaterialBatch(), item.getSourceRollId(), item.isHasDefect(), item.getDefects()));
        }
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        if (roll == null) throw new IllegalArgumentException("母卷不存在，请重新选料");
        return countedFingerprint("roll",roll.getRollId(),Arrays.asList(roll.getRollId(), roll.getWidth(), roll.getTotalLength(),
                roll.getRollModel(), roll.getBatchNo(), roll.getColor(), roll.getInspectionStatus(), roll.getDefects()));
    }

    private String countedFingerprint(String type,String id,List<?> original) {
        var values=new ArrayList<Object>(original);long counted=countRevision(type,id);
        if(counted>0)values.add(Map.of("inventoryCountRevision",counted));
        return json.writeValueAsString(values);
    }

    private void save() {
        revision = store.save(snapshot());
    }

    public synchronized void rememberPlan(CuttingPlan plan) {
        mutate(() -> {
            if (!Objects.equals(plan.baseline(), materialFingerprintInternal(plan.request())))
                throw new IllegalArgumentException("求解期间材料或疵点已更新，请重新排料");
            plans.put(plan.id(), json.readValue(json.writeValueAsBytes(plan), CuttingPlan.class));
            return null;
        });
    }

    public synchronized CuttingPlan getPlan(String id) {
        return read(() -> {
            CuttingPlan plan = plans.get(id);
            if (plan == null) throw new IllegalArgumentException("方案不存在");
            return plan;
        });
    }

    public synchronized CuttingPlan rememberAdjustment(String parentId, String id, SolveResponse result) {
        return mutate(() -> {
            CuttingPlan existing = plans.get(id);
            if (existing != null) {
                if (!Objects.equals(existing.parentPlanId(), parentId) || !json.writeValueAsString(existing.result()).equals(json.writeValueAsString(result)))
                    throw new IllegalArgumentException("调整操作编号已用于其他内容，请重新校验");
                return existing;
            }
            ensurePlanNotExecuting(parentId);
            CuttingPlan parent = plans.get(parentId);
            if (parent == null || !"PENDING".equals(parent.status())) throw new IllegalArgumentException("原方案已报工或取消，不能保存调整版");
            prepareTaskSolveInternal(parent.request());
            if (!Objects.equals(parent.baseline(), materialFingerprintInternal(parent.request())))
                throw new IllegalArgumentException("材料或疵点已变化，请重新装载并排料");
            CuttingPlan adjusted = new CuttingPlan(id, parent.request(), result, parent.baseline(), "PENDING",
                    java.time.LocalDateTime.now().toString(), parentId, parent.version()+1);
            adjusted = json.readValue(json.writeValueAsBytes(adjusted), CuttingPlan.class);
            plans.put(parentId, parent.withStatus("CANCELLED"));
            plans.put(id, adjusted);
            return adjusted;
        });
    }

    public synchronized List<CuttingPlan> taskPlans(String taskId) {
        return read(() -> plans.values().stream().filter(p -> Objects.equals(taskId, p.request().getTaskId())).toList());
    }

    public synchronized CuttingPlan changePlanStatus(String id, boolean restore) {
        return mutate(() -> {
            ensurePlanNotExecuting(id);
            CuttingPlan plan = plans.get(id);
            if (plan == null || !Set.of("PENDING", "CANCELLED").contains(plan.status()))
                throw new IllegalArgumentException("已报工方案不能取消或恢复，请通过报工记录冲销");
            if (restore) {
                prepareTaskSolveInternal(plan.request());
                if (!Objects.equals(plan.baseline(), materialFingerprintInternal(plan.request())))
                    throw new IllegalArgumentException("材料或疵点已更新，请重新排料");
            }
            CuttingPlan updated = plan.withStatus(restore ? "PENDING" : "CANCELLED");
            plans.put(id, updated); return updated;
        });
    }

    public synchronized Map<String, Object> confirmPlan(CutReport report) {
        if (report == null || report.planId() == null) throw new IllegalArgumentException("请先取得方案编号");
        Map<String, Object> existing = read(() -> receipts.get(report.planId()));
        if (existing != null) {
            if ("REVERSED".equals(existing.get("status"))) throw new IllegalArgumentException("该报工已冲销，请重新排料");
            verifyReportReplay(existing,report);
            return qualityProjection(existing);
        }
        return mutate("CUT_REPORT",report.planId(),"UNAUTHENTICATED_LOCAL",() -> confirmPlanInternal(report));
    }

    private Map<String, Object> confirmPlanInternal(CutReport report) {
        return confirmPlanInternal(report, Set.of());
    }

    private Map<String, Object> confirmPlanInternal(CutReport report, Set<String> pendingBatchPlans) {
            Map<String, Object> receipt = receipts.get(report.planId());
            if (receipt != null) {
                if ("REVERSED".equals(receipt.get("status"))) throw new IllegalArgumentException("该报工已冲销，请重新排料");
                verifyReportReplay(receipt,report);
                return qualityProjection(receipt);
            }
            CuttingPlan plan = plans.get(report.planId());
            if (plan == null || !"PENDING".equals(plan.status())) throw new IllegalArgumentException("方案不存在或已取消，请重新排料");
            if (!Objects.equals(plan.baseline(), materialFingerprintInternal(plan.request())))
                throw new IllegalArgumentException("材料或疵点已更新，请重新装载并排料");
            Map<String, Object> result = confirmInternal(plan.request(), plan.result(), report, pendingBatchPlans);
            plans.put(plan.id(), plan.withStatus("CONFIRMED"));
            return qualityProjection(result);
    }

    public synchronized Map<String, Object> getReceipt(String planId) { return read(() -> qualityProjection(receipts.get(planId))); }

    private List<QualityDisposition> qualityEvents(Map<String, Object> receipt) {
        if (!(receipt.get("qualityDispositions") instanceof List<?> events)) return List.of();
        return events.stream().map(event -> json.convertValue(event, QualityDisposition.class)).toList();
    }

    /** Read projection: original production facts are never overwritten by reinspection. Areas are m². */
    private Map<String, Object> qualityProjection(Map<String, Object> receipt) {
        if (receipt == null) return null;
        var result = new LinkedHashMap<>(receipt);
        // Untyped persisted maps may decode small revisions as Integer; keep the public projection stable.
        if(receipt.get("inventoryCountRevision") instanceof Number counted)
            result.put("inventoryCountRevision",counted.longValue());
        var events = qualityEvents(receipt);
        var removed = events.stream().filter(e -> "QUALIFIED".equals(e.originalOutcome())).toList();
        double removedArea = removed.stream().mapToDouble(QualityDisposition::pieceAreaMm2).sum() / 1_000_000;
        double recovered = events.stream().mapToDouble(QualityDisposition::recoveredAreaMm2).sum() / 1_000_000;
        double goodArea = ((Number) receipt.get("pieceArea")).doubleValue() - removedArea;
        double usedArea = ((Number) receipt.get("usedArea")).doubleValue();
        result.put("qualityDispositions", events);
        result.put("qualityRevision", events.size());
        result.put("netFinishedPieceCount", ((Number) receipt.get("finishedPieceCount")).intValue() - removed.size());
        result.put("netPieceArea", Math.max(0, goodArea));
        result.put("netRemArea", ((Number) receipt.get("remArea")).doubleValue() + recovered);
        result.put("netWasteArea", Math.max(0, ((Number) receipt.get("wasteArea")).doubleValue() + removedArea - recovered));
        result.put("netUtilization", usedArea > 0 ? Math.max(0, goodArea) / usedArea * 100 : 0);
        return result;
    }

    public synchronized Map<String, Object> qualityReview(String planId) {
        return read(() -> {
            var receipt = receipts.get(planId);
            if (receipt == null) throw new IllegalArgumentException("报工记录不存在");
            return qualityProjection(receipt);
        });
    }

    public synchronized QualityDisposition disposeQuality(String planId, QualityDisposition.Command command) {
        QualityDispositionRules.validateCommand(command);
        return mutate("QUALITY_DISPOSITION",planId,"DECLARED:"+command.inspector(),() -> {
            var receipt = receipts.get(planId);
            if (receipt == null) throw new IllegalArgumentException("报工记录不存在");
            var events = new ArrayList<>(qualityEvents(receipt));
            for (var event : events) if (event.command().operationId().equals(command.operationId())) {
                if (event.command().equals(command)) return event;
                throw new InventoryConflictException("此操作编号已用于其他复检内容，请刷新记录");
            }
            if (!"CONFIRMED".equals(receipt.get("status"))) throw new IllegalArgumentException("仅已确认报工可以复检处置");
            if (command.expectedRevision() != events.size()) throw new InventoryConflictException("复检记录已更新，请重新打开报工记录");
            if (events.stream().anyMatch(e -> e.command().pieceId() == command.pieceId()))
                throw new InventoryConflictException("该裁片已处置，不能重复转料头或报废");
            if (!(receipt.get("pieceResults") instanceof List<?> pieces)) throw new IllegalArgumentException("历史记录缺少逐件产出，不能自动复检处置");
            var piece = pieces.stream().map(p -> json.convertValue(p, ReportOutput.ReportedPiece.class))
                    .filter(p -> p.pieceId() == command.pieceId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("裁片不属于此报工"));
            var request = getPlan(planId).request();
            double recovered = QualityDispositionRules.recoveredArea(command, piece, request.getMinRemnantWidth(), request.getMinRemnantLength());
            double area = piece.shape() == null ? piece.w() * piece.l() : piece.shape().areaMm2();
            String eventId = UUID.randomUUID().toString(), now = LocalDateTime.now().toString(), remnantId = null;
            if ("REMNANT".equals(command.disposition())) {
                var region = command.recovery();
                remnantId = "REM-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM")) + "-" + String.format("%03d", remnantSeq.incrementAndGet());
                boolean isolated = "QUARANTINED".equals(region.quality());
                var child = new RemnantStock(remnantId, region.width(), region.length(), region.location().trim(), request.getRollModel(),
                        isolated ? "QUARANTINED" : "AVAILABLE", request.getRollId(), isolated, command.reason().trim());
                var parent = remnantPool.get(request.getSourceRemnantId() == null ? "" : request.getSourceRemnantId());
                child.setParentRemnantId(parent == null ? null : parent.getId());
                child.setGeneration(parent == null ? 1 : parent.getGeneration() + 1);
                child.setCreatedAt(now); child.setSourceReportId(planId); child.setSourcePieceId(piece.pieceId());
                child.setQualityDispositionId(eventId);
                remnantPool.put(remnantId, child);
            }
            var event = new QualityDisposition(eventId, planId, command, piece.demandId(), piece.outcome(), area,
                    recovered, Math.max(0, area - recovered), remnantId, now);
            events.add(event); receipt.put("qualityDispositions", events);
            return event;
        });
    }

    /** Validate a whole pending batch without booking stock; final submission commits it atomically. */
    public synchronized List<Map<String, Object>> reportBatch(List<CutReport> reports, boolean preview) {
        if (reports == null || reports.isEmpty() || reports.size() > 100)
            throw new IllegalArgumentException("请选择 1 至 100 个待报工工位");
        java.util.function.Supplier<List<Map<String, Object>>> command = () -> {
            Set<String> seen = new HashSet<>();
            Set<String> pendingBatchPlans = new HashSet<>();
            List<Map<String, Object>> result = new ArrayList<>();
            String taskId = null;
            for (CutReport report : reports) {
                if (report == null || report.planId() == null || !seen.add(report.planId()))
                    throw new IllegalArgumentException("待报工方案编号为空或重复");
                CuttingPlan plan = plans.get(report.planId());
                if (plan == null || plan.request().getTaskId() == null)
                    throw new IllegalArgumentException("待报工方案不存在或未关联任务");
                if (taskId == null) taskId = plan.request().getTaskId();
                if (!taskId.equals(plan.request().getTaskId())) throw new IllegalArgumentException("集中报工必须属于同一任务");
                boolean alreadyReported = receipts.containsKey(report.planId());
                result.add(confirmPlanInternal(report, pendingBatchPlans));
                if (!alreadyReported) pendingBatchPlans.add(report.planId());
            }
            return result;
        };
        if (!preview) return mutate("CUT_REPORT_BATCH",null,"UNAUTHENTICATED_LOCAL",command);
        return read(() -> {
            byte[] before = json.writeValueAsBytes(snapshot());
            try { return command.get(); }
            finally { restore(json.readValue(before, InventorySnapshot.class)); }
        });
    }

    public synchronized Map<String, Object> reverseReport(String planId, String reason) {
        if (reason == null || reason.isBlank() || reason.length() > 500)
            throw new IllegalArgumentException("请填写 1 至 500 字的撤回原因");
        return mutate("REPORT_REVERSE",planId,"UNAUTHENTICATED_LOCAL",() -> {
            Map<String, Object> receipt = receipts.get(planId);
            if (receipt == null) throw new IllegalArgumentException("报工记录不存在");
            if ("REVERSED".equals(receipt.get("status"))) return receipt;
            String countedType="remnant".equals(receipt.get("feedPortType"))?"remnant":"roll";
            String countedId=Objects.toString(receipt.get("remnant".equals(countedType)?"sourceRemnantId":"rollId"),"");
            long originalCount=receipt.get("inventoryCountRevision") instanceof Number n?n.longValue():0;
            if(countRevision(countedType,countedId)!=originalCount)throw new InventoryConflictException("材料已有后续盘点，不能用撤回覆盖实测库存");
            if (!qualityEvents(receipt).isEmpty()) throw new IllegalArgumentException("报工已有复检处置，不能撤回原料耗用；请保留实际裁切事实");
            if (!(receipt.get("undo") instanceof Map<?, ?> undo))
                throw new IllegalArgumentException("历史报工没有撤回快照，请人工核对库存后处理");
            List<RemnantStock> children = new ArrayList<>();
            for (Object item : (List<?>) receipt.get("derivedRemnants")) {
                RemnantStock original = json.convertValue(item, RemnantStock.class);
                ensureMaterialNotReserved("remnant",original.getId(),null);
                if(countRevision("remnant",original.getId())>0)throw new InventoryConflictException("派生料头已有盘点追溯，不能撤回原报工");
                RemnantStock current = remnantPool.get(original.getId());
                if (current == null || !json.writeValueAsString(original).equals(json.writeValueAsString(current)))
                    throw new IllegalArgumentException("派生料头 " + original.getId() + " 已流转或修改，请先撤回后续操作");
                children.add(current);
            }
            boolean remnant = "remnant".equals(receipt.get("feedPortType"));
            ensureMaterialNotReserved(remnant?"remnant":"roll",String.valueOf(receipt.get(remnant?"sourceRemnantId":"rollId")),null);
            if (remnant) {
                RemnantStock parent = remnantPool.get(receipt.get("sourceRemnantId"));
                if (parent == null || !json.writeValueAsString(parent).equals(undo.get("parentAfter")))
                    throw new IllegalArgumentException("原料头状态已变化，不能撤回此报工");
                RemnantStock original = json.readValue(undo.get("parentBefore").toString(), RemnantStock.class);
                remnantPool.put(original.getId(), original);
            } else {
                // Unwind the latest operation on this roll; independent rolls remain unaffected.
                Map<String, Object> latest = null;
                for (var candidate : receipts.values())
                    if (!"REVERSED".equals(candidate.get("status")) && "roll".equals(candidate.get("feedPortType"))
                            && Objects.equals(receipt.get("rollId"), candidate.get("rollId"))) latest = candidate;
                MotherRollInfo roll = motherRolls.get(receipt.get("rollId"));
                if (latest != receipt || roll == null ||
                        Math.abs(roll.getUsedLength() - ((Number) undo.get("usedAfter")).doubleValue()) > .001 ||
                        Math.abs(roll.getCurrentRemainingLength() - ((Number) undo.get("remainingAfter")).doubleValue()) > .001)
                    throw new IllegalArgumentException("母卷已有后续报工或库存变更，请从最近一次报工开始撤回");
                roll.setUsedLength(((Number) undo.get("usedBefore")).doubleValue());
                roll.setCurrentRemainingLength(((Number) undo.get("remainingBefore")).doubleValue());
            }
            children.forEach(child -> child.setStatus("REVERSED"));
            receipt.put("status", "REVERSED");
            receipt.put("reversedAt", LocalDateTime.now().toString());
            receipt.put("reversalReason", reason.trim());
            finishExecution(planId,"REVERSED");
            CuttingPlan plan = plans.get(planId);
            if (plan != null) plans.put(planId, plan.withStatus("REVERSED"));
            return receipt;
        });
    }

    public synchronized List<Map<String, Object>> taskReports(String taskId) {
        return read(() -> taskReportsInternal(taskId));
    }

    private List<Map<String, Object>> taskReportsInternal(String taskId) {
        return receipts.values().stream().filter(r -> Objects.equals(taskId, r.get("taskId"))).map(this::qualityProjection).toList();
    }

    public synchronized Map<String, Integer> completedQuantities(String taskId) {
        return read(() -> completedQuantitiesInternal(taskId));
    }

    private Map<String, Integer> completedQuantitiesInternal(String taskId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Map<String, Object> receipt : taskReports(taskId)) {
            if ("REVERSED".equals(receipt.get("status"))) continue;
            if (receipt.get("demandQuantities") instanceof Map<?, ?> output)
                output.forEach((id, n) -> counts.merge(id.toString(), ((Number) n).intValue(), Integer::sum));
            for (var event : qualityEvents(receipt))
                if ("QUALIFIED".equals(event.originalOutcome())) counts.merge(String.valueOf(event.demandId()), -1, Integer::sum);
        }
        return counts;
    }

    public synchronized List<CuttingTask> listTasks() { return read(() -> new ArrayList<>(tasks.values())); }

    /** Summaries and print snapshots are read from one inventory revision. */
    public synchronized List<Map<String, Object>> taskSummaries() {
        return read(() -> tasks.values().stream().map(task -> {
            Map<String, Integer> counts = completedQuantities(task.id());
            int total = task.demands().stream().mapToInt(CuttingTask.Line::quantity).sum();
            int completed = task.demands().stream().mapToInt(line -> counts.getOrDefault(String.valueOf(line.id()), 0)).sum();
            long pending = plans.values().stream().filter(plan -> Objects.equals(task.id(), plan.request().getTaskId())
                    && task.revision() == plan.request().getTaskRevision() && "PENDING".equals(plan.status())).count();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("task", task); item.put("total", total); item.put("completed", completed);
            item.put("remaining", Math.max(0, total - completed)); item.put("pendingCount", pending);
            item.put("reportCount", taskReports(task.id()).stream().filter(r -> !"REVERSED".equals(r.get("status"))).count());
            var taskExecutions=executions.values().stream().filter(e->e.taskId().equals(task.id())).toList();
            var active=taskExecutions.stream().filter(e->e.reserves(operationTime)).toList();
            var reserved=reservedQuantities(task.id(),null);
            int reservedCount=reserved.values().stream().mapToInt(Integer::intValue).sum();
            int available=task.demands().stream().mapToInt(line->Math.max(0,line.quantity()
                    -counts.getOrDefault(String.valueOf(line.id()),0)-reserved.getOrDefault(String.valueOf(line.id()),0))).sum();
            long running=active.stream().filter(e->"RUNNING".equals(e.state())).count();
            // An expired historical attempt superseded by a new execution is not an outstanding exception.
            long expired=total==completed?0:taskExecutions.stream().filter(e->"EXPIRED".equals(e.effectiveState(operationTime)))
                    .filter(e->plans.containsKey(e.planId()) && "PENDING".equals(plans.get(e.planId()).status())
                            && plans.get(e.planId()).request().getTaskRevision()==task.revision())
                    .filter(e->taskExecutions.stream().noneMatch(a->a.planId().equals(e.planId())
                            && !Set.of("EXPIRED","CANCELLED").contains(a.effectiveState(operationTime))))
                    .map(ExecutionOrder::planId).distinct().count();
            String status=running>0?"REPORT_PENDING":total==completed?"COMPLETED":expired>0?"ATTENTION":
                    !active.isEmpty() || pending>0?"EXECUTION_PENDING":"PLAN_PENDING";
            item.put("status",status);item.put("reserved",reservedCount);item.put("availableToPlan",available);
            item.put("runningCount",running);item.put("releasedCount",active.size()-running);item.put("expiredCount",expired);
            item.put("materialReservations",active.stream().map(e->Map.of("executionId",e.id(),"materialId",e.materialId(),
                    "materialType",e.materialType(),"station",e.station(),"state",e.effectiveState(operationTime))).toList());
            item.put("nextAction",switch(status) {
                case "REPORT_PENDING","ATTENTION" -> "executions";
                case "COMPLETED" -> "reports";
                case "EXECUTION_PENDING" -> active.isEmpty()?"plans":"executions";
                default -> "workspace";
            });
            return item;
        }).toList());
    }

    public synchronized Map<String, Object> planDetail(String id) {
        return read(() -> {
            CuttingPlan plan = getPlan(id);
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("id", plan.id()); detail.put("unit", "mm"); detail.put("coordinateSystem", "source-local-top-left");
            detail.put("request", plan.request()); detail.put("result", plan.result()); detail.put("status", plan.status());
            detail.put("createdAt", plan.createdAt()); detail.put("version", plan.version()); detail.put("parentPlanId", plan.parentPlanId());
            detail.put("receipt", qualityProjection(receipts.get(id)));
            return detail;
        });
    }

    public synchronized Map<String, Object> taskDetail(String id) {
        return read(() -> taskDetailInternal(id));
    }

    private Map<String, Object> taskDetailInternal(String id) {
        CuttingTask task = tasks.get(id);
        if (task == null) throw new IllegalArgumentException("切割任务不存在");
        return Map.of("task", task, "completed", completedQuantities(id), "reserved",reservedQuantities(id,null), "reports", taskReports(id), "executions",executionOrders(id));
    }

    public synchronized CuttingTask saveTask(CuttingTask input) {
        return mutate("DEMAND_ADJUSTMENT",input == null ? null : input.id(),"UNAUTHENTICATED_LOCAL",() -> saveTaskInternal(input));
    }

    private CuttingTask saveTaskInternal(CuttingTask input) {
        if (input == null || input.name() == null || input.name().isBlank() || input.materialModel() == null ||
                input.materialModel().isBlank() || input.demands() == null || input.demands().isEmpty() || input.demands().size() > 200)
            throw new IllegalArgumentException("请填写任务名称、材料型号和 1 至 200 项需求");
        String id = input.id() == null || input.id().isBlank() ? UUID.randomUUID().toString() : input.id();
        CuttingTask previous = tasks.get(id);
        if (previous == null && input.id() != null && !input.id().isBlank()) throw new IllegalArgumentException("切割任务不存在");
        if (previous != null && previous.revision() != input.revision()) throw new IllegalArgumentException("任务已更新，请重新打开后编辑");
        Set<Integer> ids = new HashSet<>();
        CuttingTask.Process process = input.process();
        if (process != null) SolveRequest.validatePieceGap(process.pieceGap());
        if (process != null && (!Double.isFinite(process.bedLength()) || process.bedLength() <= 0 ||
                !Double.isFinite(process.trimStart()) || process.trimStart() < 0 ||
                !Set.of("left-top", "right-top", "left-bottom", "right-bottom").contains(String.valueOf(process.cutOrigin())) ||
                !Set.of("horizontal", "vertical").contains(String.valueOf(process.firstStageOrientation()))))
            throw new IllegalArgumentException("机台工艺参数无效");
        for (CuttingTask.Line line : input.demands()) {
            if (line != null && line.shape() != null) {
                com.example.cutdemotwo.algorithm.solver.PolygonGeometry.validate(line.shape());
                if (line.width() != line.shape().width() || line.length() != line.shape().height())
                    throw new IllegalArgumentException("需求尺寸必须与轮廓外接尺寸一致");
            }
            if (line == null || line.id() <= 0 || !ids.add(line.id()) || line.name() == null || line.name().isBlank() ||
                    !Double.isFinite(line.width()) || !Double.isFinite(line.length()) || line.width() <= 0 || line.length() <= 0 ||
                    line.quantity() <= 0 || line.quantity() > 10000)
                throw new IllegalArgumentException("需求编号应唯一，尺寸和件数必须为正数，单项最多 10000 件");
        }
        if (previous != null) {
            Map<String, Integer> completed = completedQuantities(id);
            if (!completed.isEmpty() && !previous.materialModel().equals(input.materialModel()))
                throw new IllegalArgumentException("已有报工的任务不能更改材料型号");
            for (CuttingTask.Line old : previous.demands()) {
                int count = completed.getOrDefault(String.valueOf(old.id()), 0);
                if (count == 0) continue;
                CuttingTask.Line line = input.demands().stream().filter(d -> d.id() == old.id()).findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("已报工需求不能删除"));
                if (!Objects.equals(line.shape(), old.shape()) || line.width() != old.width() || line.length() != old.length() || !line.name().equals(old.name()) || line.quantity() < count)
                    throw new IllegalArgumentException("已报工需求的名称和尺寸不能修改，总件数不得小于已报工件数");
            }
            if (Objects.equals(previous.name(), input.name()) && Objects.equals(previous.materialModel(), input.materialModel()) &&
                    Objects.equals(previous.externalRef(), input.externalRef()) && Objects.equals(previous.process(), process) &&
                    previous.demands().equals(input.demands())) return previous;
        }
        if (previous != null && executions.values().stream().anyMatch(e->e.taskId().equals(id) && e.reserves(operationTime)))
            throw new InventoryConflictException("任务已有下达或执行中的需求，请完成报工或取消预约后编辑");
        CuttingTask task = new CuttingTask(id, input.name().trim(), input.materialModel().trim(), input.externalRef(),
                previous == null ? 1 : previous.revision() + 1, List.copyOf(input.demands()), process);
        tasks.put(id, task);
        return task;
    }

    public synchronized void prepareTaskSolve(SolveRequest request) {
        read(() -> { prepareTaskSolveInternal(request); return null; });
    }

    private void prepareTaskSolveInternal(SolveRequest request) {
        if (request == null) throw new IllegalArgumentException("排料请求不能为空");
        if (request.getTaskId() == null) return; // Existing standalone solver API remains usable.
        CuttingTask task = tasks.get(request.getTaskId());
        if (task == null || task.revision() != request.getTaskRevision()) throw new IllegalArgumentException("任务已更新，请重新载入需求");
        boolean remnant = "remnant".equals(request.getFeedPortType());
        if (!remnant && !"roll".equals(request.getFeedPortType())) throw new IllegalArgumentException("无效的材料来源");
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        RemnantStock stock = remnant ? remnantPool.get(request.getSourceRemnantId()) : null;
        if (remnant ? stock == null || !"AVAILABLE".equals(stock.getStatus()) : roll == null)
            throw new IllegalArgumentException("所选材料已不可用，请重新选料");
        String model = remnant ? stock.getMaterialBatch() : roll.getRollModel();
        if (!task.materialModel().equals(model)) throw new IllegalArgumentException("材料型号与任务需求不一致");
        double width = remnant ? stock.getWidth() : roll.getWidth();
        if (!Double.isFinite(request.getRollW()) || Math.abs(request.getRollW() - width) > .001 ||
                !Double.isFinite(request.getRollL()) || request.getRollL() <= 0 ||
                (remnant ? Math.abs(request.getRollL() - stock.getLength()) > .001 : request.getRollL() > roll.getCurrentRemainingLength()))
            throw new IllegalArgumentException("加工尺寸与所选材料库存不一致");
        double start = request.getWindowStartY();
        if (!Double.isFinite(start) || (remnant ? start != 0 : start < roll.getUsedLength() || start + request.getRollL() > roll.getTotalLength()))
            throw new IllegalArgumentException("工位超出母料可用范围，请重新装载");
        if (remnant && !Objects.equals(stock.getSourceRollId(), request.getRollId())) throw new IllegalArgumentException("料头来源母卷不一致");
        request.setRollModel(model);
        if (request.getDemands() == null || request.getDemands().isEmpty()) throw new IllegalArgumentException("没有待切需求");
        Map<String, Integer> counts = completedQuantities(task.id());
        Set<Integer> seen = new HashSet<>();
        for (var demand : request.getDemands()) {
            if (demand == null || !seen.add(demand.getId())) throw new IllegalArgumentException("排料需求编号重复或为空");
            CuttingTask.Line line = task.demands().stream().filter(d -> d.id() == demand.getId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("需求不属于当前任务"));
            if (!Objects.equals(demand.getShape(), line.shape()) || demand.getWidth() != line.width() || demand.getLength() != line.length() ||
                    demand.getDemand() <= 0 || demand.getDemand() > line.quantity() - counts.getOrDefault(String.valueOf(line.id()), 0))
                throw new IllegalArgumentException("需求尺寸或剩余数量已变化，请刷新任务后重新排料");
            demand.setName(line.name());
            demand.setAllowRotation(line.allowRotation());
        }
    }

    private void validateTaskReport(SolveRequest request, SolveResponse plan, ReportOutput result) {
        if (request.getTaskId() == null) return;
        CuttingTask task = tasks.get(request.getTaskId());
        if (task == null || task.revision() != request.getTaskRevision()) throw new IllegalArgumentException("任务已更新，请重新载入需求");
        boolean remnant = "remnant".equals(request.getFeedPortType());
        var roll = motherRolls.get(request.getRollId()); var stock = remnantPool.get(request.getSourceRemnantId() == null ? "" : request.getSourceRemnantId());
        String model = remnant ? (stock == null ? null : stock.getMaterialBatch()) : (roll == null ? null : roll.getRollModel());
        if (!Objects.equals(task.materialModel(), model)) throw new IllegalArgumentException("材料型号与任务需求不一致");
        if (remnant && !Objects.equals(stock.getSourceRollId(), request.getRollId())) throw new IllegalArgumentException("料头来源母卷不一致");
        if (plan.getPieces().stream().anyMatch(p -> p.getDemandId() == null)) throw new IllegalArgumentException("裁片缺少需求归属");
        Map<Integer, Long> good = result.qualified().stream().collect(Collectors.groupingBy(p -> p.getDemandId(), Collectors.counting()));
        Map<String, Integer> completed = completedQuantities(task.id());
        var reserved=reservedQuantities(task.id(),plan.getPlanId());
        for (var piece : plan.getPieces()) {
            var line = task.demands().stream().filter(d -> d.id() == piece.getDemandId()).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("裁片缺少需求归属"));
            double w = piece.isRotated() ? line.length() : line.width(), l = piece.isRotated() ? line.width() : line.length();
            if (Math.abs(piece.getW()-w) > .001 || Math.abs(piece.getL()-l) > .001)
                throw new IllegalArgumentException("裁片尺寸与当前需求不一致");
            if (good.getOrDefault(line.id(), 0L) > line.quantity() - completed.getOrDefault(String.valueOf(line.id()), 0) - reserved.getOrDefault(String.valueOf(line.id()),0))
                throw new IllegalArgumentException("合格裁片超过当前剩余需求，请刷新任务后核对");
        }
    }

    public synchronized List<Map<String, Object>> materialCandidates(SolveRequest request) {
        return read(() -> materialCandidatesInternal(request));
    }

    private List<Map<String, Object>> materialCandidatesInternal(SolveRequest request) {
        if (request == null || request.getRollModel() == null || request.getDemands() == null)
            throw new IllegalArgumentException("请先填写材料型号和需求");
        List<Map<String, Object>> result = new ArrayList<>();
        for (RemnantStock stock : getAvailableRemnants()) {
            if (!request.getRollModel().equals(stock.getMaterialBatch())) continue;
            addCandidate(result, request, "remnant", stock.getId(), stock.getSourceRollId(), stock.getWidth(), stock.getLength(), stock.getLocation(), stock.isHasDefect());
        }
        result.sort(Comparator.comparingDouble(c -> ((Number)c.get("width")).doubleValue() * ((Number)c.get("length")).doubleValue()));
        for (MotherRollInfo roll : motherRolls.values()) {
            if (!request.getRollModel().equals(roll.getRollModel()) || roll.getCurrentRemainingLength() <= 0) continue;
            addCandidate(result, request, "roll", roll.getRollId(), roll.getRollId(), roll.getWidth(), roll.getCurrentRemainingLength(), roll.getStorageLocation(), !roll.getDefects().isEmpty());
        }
        return result;
    }

    /** Detached read snapshot: trial nesting never holds the inventory lock or persists a plan. */
    public record RecommendationSnapshot(long revision, List<RemnantStock> stocks) {}

    public synchronized RecommendationSnapshot recommendationSnapshot(SolveRequest request, Map<String, Integer> completedBaseline) {
        return read(() -> {
            if (request.getTaskId() != null) {
                var task = tasks.get(request.getTaskId());
                if (task == null || task.revision() != request.getTaskRevision()
                        || !completedQuantities(task.id()).equals(completedBaseline))
                    throw new InventoryConflictException("任务版本或已报工数量已变化，请重新打开任务后匹配料头");
            }
            var stocks = materialCandidatesInternal(request).stream().filter(c -> "remnant".equals(c.get("type")))
                    .map(c -> remnantPool.get(c.get("id")))
                    .sorted(Comparator.comparingDouble(RemnantStock::getArea).thenComparing(RemnantStock::getId))
                    .map(stock -> json.readValue(json.writeValueAsBytes(stock), RemnantStock.class)).toList();
            return new RecommendationSnapshot(revision, stocks);
        });
    }

    public synchronized void verifyRecommendationRevision(long expected) {
        read(() -> {
            if (revision != expected) throw new InventoryConflictException("试排期间库存或任务已变化，请刷新库存后重新计算推荐");
            return null;
        });
    }

    private void addCandidate(List<Map<String, Object>> result, SolveRequest request, String type, String id, String rollId,
                              double width, double length, String location, boolean defects) {
        long fit = request.getDemands().stream().filter(d -> d != null && d.getDemand() > 0 && d.getWidth() > 0 && d.getLength() > 0 &&
                ((d.getWidth() <= width && d.getLength() <= length && (ContourWorkflow.isContour(request) || request.isAllowLongitudinal() || Math.abs(d.getWidth()-width) < .001)) ||
                 ((request.isAllowRotation() || d.isAllowRotation()) && d.getLength() <= width && d.getWidth() <= length &&
                  (ContourWorkflow.isContour(request) || request.isAllowLongitudinal() || Math.abs(d.getLength()-width) < .001)))).count();
        if (fit == 0) return;
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("type", type); row.put("id", id); row.put("rollId", rollId); row.put("width", width); row.put("length", length);
        row.put("location", location); row.put("hasDefect", defects); row.put("fittingLines", fit);
        result.add(row);
    }

    public synchronized Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report) {
        return mutate("CUT_REPORT",report.planId(),"UNAUTHENTICATED_LOCAL",() -> confirmInternal(request, plan, report));
    }

    public synchronized Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report, String baseline) {
        if (!Objects.equals(baseline, materialFingerprint(request)))
            throw new IllegalArgumentException("材料或疵点已更新，请重新装载并排料");
        return confirm(request, plan, report);
    }

    private Map<String, Object> confirmInternal(SolveRequest request, SolveResponse plan, CutReport report) {
        return confirmInternal(request, plan, report, Set.of());
    }

    private Map<String, Object> confirmInternal(SolveRequest request, SolveResponse plan, CutReport report,
                                              Set<String> pendingBatchPlans) {
        Map<String, Object> old = receipts.get(report.planId());
        if (old != null) {
            if ("REVERSED".equals(old.get("status"))) throw new IllegalArgumentException("该报工已撤回，请重新排料");
            verifyReportReplay(old,report);
            return old;
        }
        validateExecutionReport(request,plan,report);
        ReportOutput output = ReportOutput.resolve(plan, report);
        validateTaskReport(request, plan, output);
        boolean remnantFeed = "remnant".equalsIgnoreCase(request.getFeedPortType());
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        RemnantStock parent = remnantFeed ? remnantPool.get(request.getSourceRemnantId()) : null;
        if (remnantFeed && (parent == null || !"AVAILABLE".equals(parent.getStatus()))) {
            throw new IllegalArgumentException("原料头已不可用，请重新装载");
        }
        if (!remnantFeed && roll == null) throw new IllegalArgumentException("母卷不存在，请先从母卷档案装载");
        if (remnantFeed ? (Math.abs(parent.getWidth() - request.getRollW()) > 0.001 ||
                Math.abs(parent.getLength() - request.getRollL()) > 0.001) :
                Math.abs(roll.getWidth() - request.getRollW()) > 0.001) {
            throw new IllegalArgumentException("母料尺寸与库存档案不一致，请重新装载");
        }

        double len = report.actualCutLen();
        if (remnantFeed ? len != 0 : (!Double.isFinite(len) || len <= 0 || len > request.getRollL() || len > roll.getCurrentRemainingLength())) {
            throw new IllegalArgumentException("实切长度无效或超过母卷剩余长度");
        }
        if (!remnantFeed) {
            double start = request.getWindowStartY();
            if (!Double.isFinite(start) || start < 0 || start + len > roll.getTotalLength()) {
                throw new IllegalArgumentException("红框实切区间超出母卷范围");
            }
            for (Map<String, Object> receipt : receipts.values()) {
                if ("REVERSED".equals(receipt.get("status"))) continue;
                if (!request.getRollId().equals(receipt.get("rollId")) || !"roll".equals(receipt.get("feedPortType"))) continue;
                double oldStart = ((Number) receipt.get("windowStartY")).doubleValue();
                double oldEnd = oldStart + ((Number) receipt.get("actualCutLen")).doubleValue();
                // Ignore only binary arithmetic noise at touching endpoints, not a physical cutting allowance.
                double end = start + len;
                double noise = 4 * Math.max(Math.max(Math.ulp(start), Math.ulp(end)),
                        Math.max(Math.ulp(oldStart), Math.ulp(oldEnd)));
                if (Math.min(end, oldEnd) - Math.max(start, oldStart) > noise) {
                    boolean pendingConflict = pendingBatchPlans.contains(receipt.get("planId"));
                    throw new IllegalArgumentException(pendingConflict
                            ? "本工位实切区间与本批次待报工工位重叠，请核对工位位置和实切长度"
                            : "本工位实切区间与已报工区间重叠，请移动到未切区间");
                }
            }
        }
        double maxPieceY = output.cutPieces().stream().mapToDouble(p -> p.getY() + p.getL()).max().orElse(0);
        if (!remnantFeed && len + 0.001 < maxPieceY) throw new IllegalArgumentException("实切长度短于合格或异常裁片的末端");
        List<RemnantPiece> actual = report.actualRemnants() == null ? List.of() : report.actualRemnants();
        if (remnantFeed && !actual.isEmpty()) throw new IllegalArgumentException("料头只使用一次，剩余部分不再回收；请退回核对后重新报工");
        double remArea = 0;
        Set<String> seen = new HashSet<>();
        List<double[]> recoveredBounds = new ArrayList<>();
        double sourceLength = remnantFeed ? parent.getLength() : len;
        var recoveryCandidates = output.recoveryCandidates(plan, sourceLength);
        double tolerance = Double.isFinite(measurementToleranceMm) ? Math.max(0, measurementToleranceMm) : 0;
        for (RemnantPiece item : actual) {
            if (item == null || item.getId() == null || !seen.add(item.getId())) throw new IllegalArgumentException("料头编号重复或为空");
            RemnantPiece proposed = recoveryCandidates.get(item.getId());
            if (proposed == null) throw new IllegalArgumentException("料头不属于当前排料或未切区域: " + item.getId());
            if (!Double.isFinite(item.getW()) || !Double.isFinite(item.getL()) || item.getW() <= 0 || item.getL() <= 0 ||
                    item.getW() > proposed.getW() + tolerance + 0.001 || item.getL() > proposed.getL() + tolerance + 0.001 ||
                    (proposed.isHasDefect() && !item.isHasDefect()) ||
                    proposed.getX() < 0 || proposed.getY() < 0 ||
                    proposed.getX() + item.getW() > request.getRollW() + 0.001 ||
                    proposed.getY() + item.getL() > sourceLength + 0.001) {
                throw new IllegalArgumentException("实测料头超出排料范围: " + item.getId());
            }
            boolean intersectsPiece = output.cutPieces().stream().anyMatch(piece -> overlaps(
                    proposed.getX(), proposed.getY(), item.getW(), item.getL(),
                    piece.getX(), piece.getY(), piece.getW(), piece.getL()));
            boolean intersectsRemnant = recoveredBounds.stream().anyMatch(bounds -> overlaps(
                    proposed.getX(), proposed.getY(), item.getW(), item.getL(),
                    bounds[0], bounds[1], bounds[2], bounds[3]));
            if (intersectsPiece || intersectsRemnant) {
                throw new IllegalArgumentException("实测料头与成品或其他料头重叠: " + item.getId());
            }
            recoveredBounds.add(new double[]{proposed.getX(), proposed.getY(), item.getW(), item.getL()});
            remArea += item.getW() * item.getL() / 1_000_000.0;
        }
        double sourceArea = (remnantFeed ? parent.getArea() : request.getRollW() * len / 1_000_000.0);
        if (output.qualifiedArea() + output.rejectedArea() + remArea > sourceArea + 0.001) throw new IllegalArgumentException("合格、异常裁片与料头面积超过实切用料面积");

        Map<String, Object> undo = new LinkedHashMap<>();
        if (remnantFeed) {
            undo.put("parentBefore", json.writeValueAsString(parent));
            parent.setStatus("CONSUMED");
            parent.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            undo.put("parentAfter", json.writeValueAsString(parent));
        } else {
            undo.put("remainingBefore", roll.getCurrentRemainingLength());
            undo.put("usedBefore", roll.getUsedLength());
            roll.setCurrentRemainingLength(roll.getCurrentRemainingLength() - len);
            roll.setUsedLength(roll.getUsedLength() + len);
            undo.put("remainingAfter", roll.getCurrentRemainingLength());
            undo.put("usedAfter", roll.getUsedLength());
        }
        List<RemnantStock> children = new ArrayList<>();
        List<Map<String, Object>> recoveredGeometry = new ArrayList<>();
        for (RemnantPiece item : actual) {
            if (item.getW() < request.getMinRemnantWidth() || item.getL() < request.getMinRemnantLength()) continue;
            RemnantPiece proposed = recoveryCandidates.get(item.getId());
            List<Defect> childDefects = new ArrayList<>();
            for (Defect defect : request.getDefects()) {
                double left = Math.max(proposed.getX(), defect.getSafeX());
                double top = Math.max(proposed.getY(), defect.getSafeY());
                double right = Math.min(proposed.getX() + item.getW(), defect.getSafeX() + defect.getSafeW());
                double bottom = Math.min(proposed.getY() + item.getL(), defect.getSafeY() + defect.getSafeH());
                if (right > left && bottom > top) {
                    childDefects.add(new Defect(defect.getId(), left - proposed.getX(), top - proposed.getY(),
                            right - left, bottom - top, 0, defect.getDefectType(), defect.getTypeName(),
                            defect.getSeverity(), defect.getPoints(), defect.getDetectionSource(),
                            defect.getAvoidanceStrategy(), defect.getDescription()));
                }
            }
            String id = "REM-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM")) + "-" +
                    String.format("%03d", remnantSeq.incrementAndGet());
            RemnantStock child = new RemnantStock(id, item.getW(), item.getL(),
                    report.location() == null || report.location().isBlank() ? "现场料头架" : report.location(),
                    request.getRollModel(), item.isHasDefect() && childDefects.isEmpty() ? "QUARANTINED" : "AVAILABLE",
                    request.getRollId(), item.isHasDefect() || !childDefects.isEmpty(), item.getStatus());
            child.setDefects(childDefects);
            child.setParentRemnantId(remnantFeed ? parent.getId() : null);
            child.setGeneration(remnantFeed ? parent.getGeneration() + 1 : 1);
            child.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            remnantPool.put(id, child);
            children.add(child);
            recoveredGeometry.add(Map.of("id", id, "sourceCandidateId", proposed.getId(), "x", proposed.getX(), "y", proposed.getY(),
                    "w", item.getW(), "l", item.getL(), "area", child.getArea(), "hasDefect", child.isHasDefect()));
        }
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("planId", report.planId());
        receipt.put("status", "CONFIRMED");
        receipt.put("undo", undo);
        receipt.put("taskId", request.getTaskId());
        receipt.put("sourceRemnantId", request.getSourceRemnantId());
        Map<String, Integer> quantities = new LinkedHashMap<>();
        output.qualified().forEach(p -> quantities.merge(String.valueOf(p.getDemandId()), 1, Integer::sum));
        receipt.put("demandQuantities", quantities);
        receipt.put("pieceResults", output.details());
        receipt.put("rejectedPieceCount", output.rejected().size());
        receipt.put("uncutPieceCount", output.uncut().size());
        receipt.put("rejectedArea", output.rejectedArea());
        receipt.put("rollId", request.getRollId());
        receipt.put("windowStartY", request.getWindowStartY());
        receipt.put("feedPortType", remnantFeed ? "remnant" : "roll");
        receipt.put("actualCutLen", len);
        receipt.put("remainingLength", roll == null ? null : roll.getCurrentRemainingLength());
        receipt.put("finishedPieceCount", report.finishedPieceCount());
        receipt.put("pieceArea", output.qualifiedArea());
        receipt.put("usedArea", sourceArea);
        receipt.put("processingArea", request.getRollW() * request.getRollL() / 1_000_000.0);
        double recoveredArea = children.stream().mapToDouble(RemnantStock::getArea).sum();
        receipt.put("remArea", recoveredArea);
        receipt.put("wasteArea", Math.max(0, sourceArea - output.qualifiedArea() - recoveredArea));
        receipt.put("utilization", sourceArea == 0 ? 0 : output.qualifiedArea() / sourceArea * 100);
        receipt.put("derivedRemnants", children);
        receipt.put("recoveredGeometry", recoveredGeometry);
        receipt.put("inventoryCountRevision",countRevision(remnantFeed?"remnant":"roll",remnantFeed?request.getSourceRemnantId():request.getRollId()));
        receipt.put("confirmedAt", LocalDateTime.now().toString());
        receipt.put("reportContent",json.writeValueAsString(report));
        receipts.put(report.planId(), receipt);
        finishExecution(report.planId(),"REPORTED");
        return receipt;
    }

    public synchronized boolean resetRoll(String rollId) {
        return resetRoll(rollId, false);
    }

    public synchronized boolean resetRoll(String rollId, boolean force) {
        return mutate("DEMO_RESET",rollId,"UNAUTHENTICATED_LOCAL",() -> resetRollInternal(rollId, force));
    }

    private boolean resetRollInternal(String rollId, boolean force) {
        ensureMaterialNotReserved("roll",rollId,null);
        if(counts.values().stream().flatMap(c->c.lines().stream()).anyMatch(line->
                "roll".equals(line.type()) && rollId.equals(line.id()) || "remnant".equals(line.type())
                && remnantPool.containsKey(line.id()) && rollId.equals(remnantPool.get(line.id()).getSourceRollId())))
            throw new InventoryConflictException("材料已有盘点单追溯，禁止演示重置；请新建盘点单更正");
        if(transfers.values().stream().flatMap(t->t.lines().stream()).anyMatch(line->
                "roll".equals(line.type()) && rollId.equals(line.id()) || "remnant".equals(line.type())
                && remnantPool.containsKey(line.id()) && rollId.equals(remnantPool.get(line.id()).getSourceRollId())))
            throw new InventoryConflictException("材料已有移库单追溯，禁止演示重置；请新建移库单更正库位");
        if(executions.values().stream().anyMatch(e->Objects.equals(e.materialId(),rollId) || plans.containsKey(e.planId()) && Objects.equals(plans.get(e.planId()).request().getRollId(),rollId)))
            throw new InventoryConflictException("材料已有执行单追溯，禁止演示重置");
        MotherRollInfo roll = motherRolls.get(rollId);
        if (roll == null) return false;
        if (receipts.values().stream().anyMatch(r -> rollId.equals(r.get("rollId")) && !qualityEvents(r).isEmpty()))
            throw new IllegalArgumentException("母卷已有复检处置，不能通过演示重置清除产出追溯");
        if (receipts.values().stream().anyMatch(r -> rollId.equals(r.get("rollId"))))
            throw new IllegalArgumentException("该母卷已有报工记录，不能通过演示重置清除；请保留原记录并按实际情况冲销");
        roll.setCurrentRemainingLength(roll.getTotalLength());
        roll.setUsedLength(0.0);
        remnantPool.entrySet().removeIf(e -> rollId.equals(e.getValue().getSourceRollId()));
        if ("ROLL-2026-0920".equals(rollId)) {
            RemnantStock r1 = new RemnantStock("REM-202609-001", 2000, 1600, "库位 A-01-03", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", false, "完好可用短料 (Word 表1算例)");
            r1.setGeneration(1);
            r1.setQualityGrade("GRADE_A");
            r1.setCreatedAt("2026-09-20 14:30");
            remnantPool.put(r1.getId(), r1);

            RemnantStock r2 = new RemnantStock("REM-202609-002", 500, 4000, "库位 B-02-08", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", false, "右侧纵切可用长料头");
            r2.setGeneration(1);
            r2.setQualityGrade("GRADE_A");
            r2.setCreatedAt("2026-09-20 16:15");
            remnantPool.put(r2.getId(), r2);

            RemnantStock r3 = new RemnantStock("REM-202609-003", 500, 4000, "库位 D-DEF-01", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", true, "左侧带疵料头 (内部含瑕疵需避让)");
            r3.setGeneration(1);
            r3.setQualityGrade("GRADE_DEFECT");
            r3.setCreatedAt("2026-09-20 17:40");
            List<Defect> defs = new ArrayList<>();
            defs.add(new Defect(1, 200, 1500, 150, 600, 30, "HOLE", "破洞残留", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "料头内局部破洞"));
            r3.setDefects(defs);
            remnantPool.put(r3.getId(), r3);
        }
        return true;
    }

    private static boolean overlaps(double x, double y, double w, double l,
                                    double otherX, double otherY, double otherW, double otherL) {
        return x < otherX + otherW && x + w > otherX && y < otherY + otherL && y + l > otherY;
    }

    private void initMotherRolls() {
        // 母卷 1: ROLL-2026-0920 (TC涤棉)
        MotherRollInfo roll1 = new MotherRollInfo("ROLL-2026-0920", "TC涤棉-B2026", "BAT-202609-A1",
                "华联高新纺织印染有限公司", "65/35涤棉高密斜纹布", "藏青色 (PANTONE 19-4024)",
                240.0, "65%涤纶, 35%精梳棉", 2000, 60000, "原料立库 R-01-A03");
        roll1.setCurrentRemainingLength(55000);
        roll1.setUsedLength(5000);
        roll1.setInspectionStatus("PASSED");
        roll1.setInspector("AI-SCANNER-01 (视觉验布复核)");
        roll1.setInspectionDate("2026-09-20");

        // 录入 8 处纺织 4 分制标准疵点
        List<Defect> defs1 = new ArrayList<>();
        defs1.add(new Defect(1, 400, 1400, 200, 150, 20, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，4分制重疵，切断隔离"));
        defs1.add(new Defect(2, 1100, 3200, 160, 100, 20, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，影响受力，强制避让"));
        defs1.add(new Defect(3, 200, 8500, 300, 200, 20, "STAIN", "油污渍斑", 2, 2, "MANUAL_INSPECT", "MUST_AVOID", "印染滴油污渍，避开合格裁片"));
        defs1.add(new Defect(4, 1500, 14200, 150, 400, 25, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "织机断纬"));
        defs1.add(new Defect(5, 700, 22100, 100, 80, 15, "SLUB", "粗节结头", 1, 1, "AI_VISION_SCANNER", "PENETRABLE", "轻微粗节，允许落入带疵料头"));
        defs1.add(new Defect(6, 1200, 31500, 250, 180, 25, "HOLE", "撕裂破洞", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "落布撕破，必须切除隔离"));
        defs1.add(new Defect(7, 500, 45000, 400, 300, 20, "WEFT_DEFECT", "稀密档", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "纬密不匀条斑"));
        defs1.add(new Defect(8, 1600, 54200, 300, 150, 20, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色左中右色差"));
        roll1.setDefects(defs1);
        motherRolls.put(roll1.getRollId(), roll1);

        // 母卷 2: ROLL-2026-0921 (纯棉斜纹)
        MotherRollInfo roll2 = new MotherRollInfo("ROLL-2026-0921", "纯棉斜纹-C2026", "BAT-202609-B2",
                "魏桥纺织股份有限公司", "100%精梳纯棉斜纹", "米白色 (PANTONE 11-0601)",
                210.0, "100%精梳棉", 1800, 50000, "原料立库 R-02-B01");
        roll2.setCurrentRemainingLength(48000);
        roll2.setUsedLength(2000);
        roll2.setInspectionStatus("PASSED");
        roll2.setInspector("李师傅 (人工验布标定)");
        roll2.setInspectionDate("2026-09-21");

        List<Defect> defs2 = new ArrayList<>();
        defs2.add(new Defect(9, 300, 2500, 180, 120, 20, "STAIN", "黄斑水渍", 2, 2, "MANUAL_INSPECT", "MUST_AVOID", "水渍泛黄"));
        defs2.add(new Defect(10, 1200, 16800, 140, 200, 20, "HOLE", "织孔破损", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织针损伤破洞"));
        defs2.add(new Defect(11, 800, 33000, 200, 100, 15, "SLUB", "棉结死棉", 1, 1, "AI_VISION_SCANNER", "PENETRABLE", "棉结"));
        roll2.setDefects(defs2);
        motherRolls.put(roll2.getRollId(), roll2);

        // 母卷 3: ROLL-2026-0922 (弹力牛津)
        MotherRollInfo roll3 = new MotherRollInfo("ROLL-2026-0922", "弹力牛津-O2026", "BAT-202609-C3",
                "盛泽东方丝绸纺织", "锦棉弹力牛津纺", "墨绿色 (PANTONE 19-5513)",
                280.0, "70%锦纶, 25%棉, 5%氨纶", 2200, 80000, "原料立库 R-03-C05");
        roll3.setCurrentRemainingLength(80000);
        roll3.setUsedLength(0);
        roll3.setInspectionStatus("PENDING");
        roll3.setInspector("待视觉上线");
        roll3.setInspectionDate("2026-09-21");

        List<Defect> defs3 = new ArrayList<>();
        defs3.add(new Defect(12, 1000, 12000, 250, 180, 20, "WEFT_DEFECT", "氨纶断丝", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "弹力氨纶丝断"));
        roll3.setDefects(defs3);
        motherRolls.put(roll3.getRollId(), roll3);

        MotherRollInfo curtain2d = new MotherRollInfo("ROLL-DEMO-2D", "窗帘样布-2D", "DEMO-2D",
                "演示样布", "窗帘矩形样布", "米白色", 220, "演示面料", 2000, 30000, "演示库位");
        curtain2d.setInspectionStatus("PASSED");
        curtain2d.setDefects(new ArrayList<>(List.of(new Defect(21, 200, 1500, 150, 600, 50,
                "HOLE", "带疵改宽区域", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "二维带疵点演示"))));
        motherRolls.put(curtain2d.getRollId(), curtain2d);

        // 真实布艺母卷 1: ROLL-REAL-893292 (2#A3A-Cream · 100m 卷装)
        MotherRollInfo real893292 = new MotherRollInfo("ROLL-REAL-893292", "2#A3A-Cream", "BAT-REAL-893292",
                "真实布艺供应链 (893292)", "窗帘高密提花雪尼尔 (2#A3A-Cream)", "米色 (Cream)",
                380.0, "100%涤纶高密遮光", 2800, 100000, "布艺成品库 A-08-01");
        real893292.setCurrentRemainingLength(100000);
        real893292.setUsedLength(0);
        real893292.setInspectionStatus("PASSED");
        real893292.setInspector("AI视觉验布机-03 (已复核)");
        real893292.setInspectionDate("2026-09-28");
        List<Defect> defs893292 = new ArrayList<>(List.of(
                new Defect(1, 2118.8, 3630.6, 144.1, 180.2, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱，避让"),
                new Defect(2, 1084.7, 9729.0, 251.8, 107.1, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(3, 914.7, 10595.8, 131.1, 242.7, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(4, 918.1, 11466.1, 176.0, 141.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(5, 1357.6, 14244.5, 261.4, 204.1, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(6, 1674.6, 23417.1, 115.8, 129.8, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱，避让"),
                new Defect(7, 163.9, 24621.8, 215.5, 199.8, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(8, 2141.6, 54218.6, 254.6, 247.5, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，强制避让"),
                new Defect(9, 2155.3, 55782.6, 176.0, 157.1, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(10, 724.4, 58663.5, 174.0, 115.6, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，强制避让"),
                new Defect(11, 472.8, 59798.8, 229.6, 183.6, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(12, 738.6, 69580.5, 149.0, 158.6, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(13, 848.5, 71027.9, 237.6, 117.3, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(14, 855.7, 73455.8, 145.8, 85.5, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(15, 1517.2, 73542.7, 113.2, 235.2, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开")
        ));
        real893292.setDefects(defs893292);
        motherRolls.put(real893292.getRollId(), real893292);

        // 真实布艺母卷 2: ROLL-REAL-893153 (2#1A-Off White · 100m 卷装)
        MotherRollInfo real893153 = new MotherRollInfo("ROLL-REAL-893153", "2#1A-Off White", "BAT-REAL-893153",
                "真实布艺供应链 (893153)", "工程高密垂感遮光布 (2#1A-Off White)", "米白 (Off White)",
                360.0, "100%高支密涤纶", 2800, 100000, "布艺成品库 A-08-02");
        real893153.setCurrentRemainingLength(100000);
        real893153.setUsedLength(0);
        real893153.setInspectionStatus("PASSED");
        real893153.setInspector("AI视觉验布机-02 (已复核)");
        real893153.setInspectionDate("2026-09-28");
        List<Defect> defs893153 = new ArrayList<>(List.of(
                new Defect(1, 1200.0, 4200.0, 180.0, 150.0, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱避让"),
                new Defect(2, 600.0, 11500.0, 200.0, 120.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "切断隔离破洞"),
                new Defect(3, 1800.0, 18200.0, 150.0, 220.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污避开"),
                new Defect(4, 900.0, 27800.0, 160.0, 140.0, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "抽纱瑕疵"),
                new Defect(5, 2100.0, 35400.0, 220.0, 180.0, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "色差瑕疵"),
                new Defect(6, 400.0, 44200.0, 130.0, 160.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "破损点隔离"),
                new Defect(7, 1500.0, 52000.0, 190.0, 130.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "油污斑块"),
                new Defect(8, 800.0, 61500.0, 240.0, 170.0, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "抽纱疵点"),
                new Defect(9, 1700.0, 71200.0, 150.0, 190.0, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "色差条斑"),
                new Defect(10, 500.0, 80400.0, 180.0, 140.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞"),
                new Defect(11, 1300.0, 88900.0, 210.0, 160.0, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "跳纱瑕疵"),
                new Defect(12, 1900.0, 96500.0, 160.0, 200.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污")
        ));
        real893153.setDefects(defs893153);
        motherRolls.put(real893153.getRollId(), real893153);
    }

    private void initSampleRemnants() {
        // 母卷 ROLL-2026-0920 切下的料头
        RemnantStock r1 = new RemnantStock("REM-202609-001", 2000, 1600, "库位 A-01-03", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "完好可用短料 (Word 表1算例)");
        r1.setGeneration(1);
        r1.setQualityGrade("GRADE_A");
        r1.setCreatedAt("2026-09-20 14:30");
        remnantPool.put(r1.getId(), r1);

        RemnantStock r2 = new RemnantStock("REM-202609-002", 500, 4000, "库位 B-02-08", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "右侧纵切可用长料头");
        r2.setGeneration(1);
        r2.setQualityGrade("GRADE_A");
        r2.setCreatedAt("2026-09-20 16:15");
        remnantPool.put(r2.getId(), r2);

        RemnantStock r3 = new RemnantStock("REM-202609-003", 500, 4000, "库位 D-DEF-01", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", true, "左侧带疵料头 (内部含瑕疵需避让)");
        r3.setGeneration(1);
        r3.setQualityGrade("GRADE_DEFECT");
        r3.setCreatedAt("2026-09-20 17:40");
        List<Defect> defs = new ArrayList<>();
        defs.add(new Defect(1, 200, 1500, 150, 600, 30, "HOLE", "破洞残留", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "料头内局部破洞"));
        r3.setDefects(defs);
        remnantPool.put(r3.getId(), r3);

        // 母卷 ROLL-2026-0921 切下的料头
        RemnantStock r4 = new RemnantStock("REM-202609-004", 1800, 1200, "库位 C-01-05", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉完好短料");
        r4.setGeneration(1);
        r4.setQualityGrade("GRADE_A");
        r4.setCreatedAt("2026-09-21 09:00");
        remnantPool.put(r4.getId(), r4);

        RemnantStock r5 = new RemnantStock("REM-202609-005", 400, 3000, "库位 C-02-02", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉分条长料头");
        r5.setGeneration(1);
        r5.setQualityGrade("GRADE_A");
        r5.setCreatedAt("2026-09-21 09:20");
        remnantPool.put(r5.getId(), r5);
    }

    public synchronized List<MotherRollInfo> getMotherRolls() {
        return read(() -> getMotherRollsInternal());
    }

    private List<MotherRollInfo> getMotherRollsInternal() {
        List<MotherRollInfo> list = new ArrayList<>();
        for (MotherRollInfo info : motherRolls.values()) {
            List<RemnantStock> rollRemnants = getRemnantsByRollId(info.getRollId());
            double totalArea = rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum();
            info.setRemnantCount(rollRemnants.size());
            info.setRemnantTotalArea(totalArea);
            list.add(info);
        }
        return list;
    }

    public synchronized MotherRollInfo getMotherRoll(String rollId) {
        return read(() -> getMotherRollInternal(rollId));
    }

    private MotherRollInfo getMotherRollInternal(String rollId) {
        if (rollId == null) return null;
        MotherRollInfo info = motherRolls.get(rollId);
        if (info != null) {
            List<RemnantStock> rollRemnants = getRemnantsByRollId(rollId);
            info.setRemnantCount(rollRemnants.size());
            info.setRemnantTotalArea(rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum());
        }
        return info;
    }

    public synchronized MotherRollInfo saveOrUpdateMotherRoll(MotherRollInfo roll) {
        return mutate("ROLL_RECEIPT_OR_UPDATE",roll == null ? null : roll.getRollId(),"UNAUTHENTICATED_LOCAL",() -> saveOrUpdateMotherRollInternal(roll));
    }

    private MotherRollInfo saveOrUpdateMotherRollInternal(MotherRollInfo roll) {
        if (roll == null || roll.getRollId() == null || roll.getRollId().trim().isEmpty()) {
            throw new IllegalArgumentException("母卷编号 (rollId) 不能为空！");
        }
        if (!Double.isFinite(roll.getWidth()) || !Double.isFinite(roll.getTotalLength()) ||
                roll.getWidth() <= 0 || roll.getTotalLength() <= 0) {
            throw new IllegalArgumentException("母卷幅宽和总长度必须大于零");
        }
        ensureMaterialNotReserved("roll",roll.getRollId(),null);
        MotherRollInfo existing = motherRolls.get(roll.getRollId());
        if (existing != null) {
            if (Math.abs(existing.getWidth() - roll.getWidth()) > 0.001 ||
                    Math.abs(existing.getTotalLength() - roll.getTotalLength()) > 0.001) {
                throw new IllegalArgumentException("已登记母卷的物理尺寸不可直接覆盖");
            }
            existing.setRollModel(roll.getRollModel());
            existing.setBatchNo(roll.getBatchNo());
            existing.setSupplier(roll.getSupplier());
            existing.setMaterialName(roll.getMaterialName());
            existing.setColor(roll.getColor());
            existing.setGrammage(roll.getGrammage());
            existing.setComposition(roll.getComposition());
            existing.setWidth(roll.getWidth());
            existing.setRawWidth(roll.getRawWidth());
            existing.setTotalLength(roll.getTotalLength());
            if(!Objects.equals(Objects.toString(existing.getStorageLocation(),""),Objects.toString(roll.getStorageLocation(),"")))
                throw new IllegalArgumentException("已登记材料请通过移库单变更库位");
            existing.setInspectionStatus(roll.getInspectionStatus());
            if (roll.getDefects() != null && !roll.getDefects().isEmpty()) {
                existing.setDefects(roll.getDefects());
            }
            return existing;
        } else {
            if (roll.getCreatedAt() == null) {
                roll.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
            }
            if (roll.getCurrentRemainingLength() <= 0) {
                roll.setCurrentRemainingLength(roll.getTotalLength());
            }
            motherRolls.put(roll.getRollId(), roll);
            return roll;
        }
    }

    public synchronized Defect addDefectToRoll(String rollId, Defect defect) {
        return mutate("INSPECTION",rollId,"UNAUTHENTICATED_LOCAL",() -> addDefectToRollInternal(rollId, defect));
    }

    public record InspectionInput(double width, double totalLength, List<Defect> defects) {}

    public synchronized MotherRollInfo createInspectionRoll(MotherRollInfo input) {
        return mutate("ROLL_RECEIPT",input == null ? null : input.getRollId(),"UNAUTHENTICATED_LOCAL",() -> {
            if (input == null || input.getRollId() == null || input.getRollId().isBlank())
                throw new IllegalArgumentException("请输入母卷编号");
            if (motherRolls.containsKey(input.getRollId())) throw new IllegalArgumentException("此母卷编号已存在，请选择已有母卷");
            var roll = new MotherRollInfo();
            roll.setRollId(input.getRollId()); roll.setRollModel(input.getRollModel());
            roll.setWidth(input.getWidth()); roll.setRawWidth(input.getWidth()); roll.setTotalLength(input.getTotalLength());
            roll.setInspectionStatus("PENDING"); roll.setInspector("人工验布");
            roll.setInspectionDate(null); roll.setCreatedAt(LocalDateTime.now().toString());
            return saveOrUpdateMotherRollInternal(roll);
        });
    }

    public synchronized MotherRollInfo saveInspection(String rollId, InspectionInput input) {
        return mutate("INSPECTION",rollId,"UNAUTHENTICATED_LOCAL",() -> {
            var roll = motherRolls.get(rollId);
            if (roll == null) throw new IllegalArgumentException("未找到母卷，请重新选择");
            if (input == null || input.width() != roll.getWidth() || input.totalLength() != roll.getTotalLength())
                throw new IllegalArgumentException("母卷尺寸已变化，请重新载入后核对标记");
            if (input.defects() == null || input.defects().isEmpty() || input.defects().size() > 5000)
                throw new IllegalArgumentException("每次请保存 1–5000 处疵点");
            var keys = new HashSet<String>();
            for (var incoming : input.defects()) {
                if (incoming == null || incoming.getCaptureId() == null || !incoming.getCaptureId().matches("[a-zA-Z0-9-]{1,80}")
                        || !keys.add(incoming.getCaptureId())) throw new IllegalArgumentException("疵点记录标识无效或重复");
                var defect = json.readValue(json.writeValueAsBytes(incoming), Defect.class);
                defect.setId(0);
                defect.setDetectionSource("MANUAL_INSPECT");
                defect.setAvoidanceStrategy("MUST_AVOID");
                var existing = roll.getDefects().stream().filter(d -> incoming.getCaptureId().equals(d.getCaptureId())).findFirst();
                if (existing.isPresent()) {
                    var copy = json.readValue(json.writeValueAsBytes(existing.get()), Defect.class); copy.setId(0);
                    if (!json.writeValueAsString(copy).equals(json.writeValueAsString(defect)))
                        throw new IllegalArgumentException("此疵点已保存，内容与本地记录不同，请重新载入核对");
                    continue; // A retry after a lost response must not duplicate physical defects.
                }
                for (double n : new double[]{defect.getX(), defect.getY(), defect.getW(), defect.getH(), defect.getMargin()})
                    if (!Double.isFinite(n) || Math.abs(n * 10 - Math.rint(n * 10)) > .000001)
                        throw new IllegalArgumentException("疵点位置和尺寸须精确到 0.1 mm");
                addDefectToRollInternal(rollId, defect);
            }
            return roll;
        });
    }

    private Defect addDefectToRollInternal(String rollId, Defect defect) {
        ensureMaterialNotReserved("roll",rollId,null);
        MotherRollInfo roll = getMotherRoll(rollId);
        if (roll == null) {
            throw new IllegalArgumentException("未找到母卷: " + rollId);
        }
        if (defect == null || !Double.isFinite(defect.getX()) || !Double.isFinite(defect.getY()) ||
                !Double.isFinite(defect.getW()) || !Double.isFinite(defect.getH()) ||
                defect.getX() < 0 || defect.getY() < 0 || defect.getW() <= 0 || defect.getH() <= 0 ||
                defect.getX() + defect.getW() > roll.getWidth() ||
                defect.getY() + defect.getH() > roll.getTotalLength()) {
            throw new IllegalArgumentException("疵点坐标或尺寸超出母卷范围");
        }
        if (!Double.isFinite(defect.getMargin()) || defect.getMargin() < 0)
            throw new IllegalArgumentException("疵点避让间距必须是非负数");
        if (defect.getId() == 0) {
            defectSeq.accumulateAndGet(roll.getDefects().stream().mapToInt(Defect::getId).max().orElse(0), Math::max);
            defect.setId(defectSeq.incrementAndGet());
        }
        roll.getDefects().add(defect);
        return defect;
    }

    public synchronized boolean scrapRemnant(String id, String reason) {
        return mutate("REMNANT_SCRAP",id,"UNAUTHENTICATED_LOCAL",() -> scrapRemnantInternal(id, reason));
    }

    private boolean scrapRemnantInternal(String id, String reason) {
        ensureMaterialNotReserved("remnant",id,null);
        RemnantStock item = remnantPool.get(id);
        if (item == null) return false;
        if("LOST".equals(item.getStatus()))throw new InventoryConflictException("盘亏料头未见实物，不能报废；找回请登记盘点单");
        item.setStatus("SCRAPPED");
        item.setDefectDesc((item.getDefectDesc() != null ? item.getDefectDesc() + " | " : "") + "已报废: " + reason);
        return true;
    }

    public synchronized List<RemnantStock> getAvailableRemnants() {
        return read(() -> getAvailableRemnantsInternal());
    }

    private List<RemnantStock> getAvailableRemnantsInternal() {
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .sorted(Comparator.comparing(RemnantStock::getId))
                .collect(Collectors.toList());
    }

    public synchronized List<RemnantStock> getRemnantsByRollId(String rollId) {
        return read(() -> getRemnantsByRollIdInternal(rollId));
    }

    private List<RemnantStock> getRemnantsByRollIdInternal(String rollId) {
        if (rollId == null || rollId.trim().isEmpty() || "ALL".equalsIgnoreCase(rollId)) {
            return getAvailableRemnants();
        }
        String cleanRollId = rollId.trim();
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .filter(r -> cleanRollId.equalsIgnoreCase(r.getSourceRollId()))
                .sorted(Comparator.comparing(RemnantStock::getId))
                .collect(Collectors.toList());
    }

    public synchronized List<RemnantStock> getAllRemnants() {
        return read(() -> getAllRemnantsInternal());
    }

    private List<RemnantStock> getAllRemnantsInternal() {
        return new ArrayList<>(remnantPool.values());
    }

    public synchronized RemnantStock scanOrGetById(String id) {
        return read(() -> scanOrGetByIdInternal(id));
    }

    private RemnantStock scanOrGetByIdInternal(String id) {
        if (id == null) return null;
        String cleanId = id.trim();
        RemnantStock direct = remnantPool.get(cleanId);
        if (direct != null && "AVAILABLE".equalsIgnoreCase(direct.getStatus())) {
            return direct;
        }
        for (RemnantStock r : remnantPool.values()) {
            if ("AVAILABLE".equalsIgnoreCase(r.getStatus()) &&
                    (r.getId().equalsIgnoreCase(cleanId) || r.getId().endsWith(cleanId))) {
                return r;
            }
        }
        return null;
    }

    public synchronized List<RemnantStock> matchRemnants(String rollId, double pieceW, double pieceL, boolean allowRotation) {
        return read(() -> matchRemnantsInternal(rollId, pieceW, pieceL, allowRotation));
    }

    private List<RemnantStock> matchRemnantsInternal(String rollId, double pieceW, double pieceL, boolean allowRotation) {
        List<RemnantStock> candidates = getRemnantsByRollId(rollId);
        List<RemnantStock> matched = new ArrayList<>();
        for (RemnantStock r : candidates) {
            if (r.isHasDefect()) continue;
            boolean fitsNormal = (r.getWidth() >= pieceW && r.getLength() >= pieceL);
            boolean fitsRotated = allowRotation && (r.getWidth() >= pieceL && r.getLength() >= pieceW);
            if (fitsNormal || fitsRotated) {
                matched.add(r);
            }
        }
        matched.sort(Comparator.comparingDouble(RemnantStock::getArea));
        return matched;
    }

    public synchronized RemnantStock registerRemnant(RemnantStock item) {
        return mutate("REMNANT_RECEIPT",item == null ? null : item.getId(),"UNAUTHENTICATED_LOCAL",() -> registerRemnantInternal(item));
    }

    private RemnantStock registerRemnantInternal(RemnantStock item) {
        if (item == null || !Double.isFinite(item.getWidth()) || !Double.isFinite(item.getLength()) ||
                item.getWidth() <= 0 || item.getLength() <= 0) throw new IllegalArgumentException("料头宽长必须大于零");
        if (item.getId() == null || item.getId().trim().isEmpty()) {
            String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
            item.setId("REM-" + dateStr + "-" + String.format("%03d", remnantSeq.incrementAndGet()));
        }
        if (remnantPool.containsKey(item.getId())) throw new IllegalArgumentException("料头编号已存在: " + item.getId());
        if (item.getCreatedAt() == null) {
            item.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        }
        if (item.getStatus() == null) {
            item.setStatus("AVAILABLE");
        }
        remnantPool.put(item.getId(), item);
        return item;
    }

    public synchronized RemnantStock autoRegisterCutRemnant(String rollId, String parentRemnantId, double w, double l, boolean hasDefect, String desc) {
        return mutate("REMNANT_RECEIPT",rollId,"UNAUTHENTICATED_LOCAL",() -> autoRegisterCutRemnantInternal(rollId, parentRemnantId, w, l, hasDefect, desc));
    }

    private RemnantStock autoRegisterCutRemnantInternal(String rollId, String parentRemnantId, double w, double l, boolean hasDefect, String desc) {
        String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
        String newId = "REM-" + dateStr + "-" + String.format("%03d", remnantSeq.incrementAndGet());
        if (parentRemnantId != null && !parentRemnantId.isEmpty()) {
            newId = parentRemnantId + "-SUB" + remnantSeq.get();
        }
        RemnantStock rs = new RemnantStock(newId, w, l, "现场料头架", rollId, "AVAILABLE", rollId, hasDefect, desc);
        rs.setParentRemnantId(parentRemnantId);
        rs.setGeneration(parentRemnantId != null ? 2 : 1);
        rs.setQualityGrade(hasDefect ? "GRADE_DEFECT" : "GRADE_A");
        rs.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        remnantPool.put(rs.getId(), rs);
        return rs;
    }

    public synchronized boolean consumeRemnant(String id) {
        return mutate("REMNANT_ISSUE",id,"UNAUTHENTICATED_LOCAL",() -> consumeRemnantInternal(id));
    }

    private boolean consumeRemnantInternal(String id) {
        ensureMaterialNotReserved("remnant",id,null);
        if (id == null) return false;
        RemnantStock item = remnantPool.get(id);
        if (item != null) {
            if("CONSUMED".equals(item.getStatus()))return true;
            if(!"AVAILABLE".equals(item.getStatus()))throw new InventoryConflictException("只有可用料头可以领用；盘亏找回后须先完成质量检验");
            item.setStatus("CONSUMED");
            item.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            return true;
        }
        return false;
    }

    public synchronized boolean updateStatus(String id, String status) {
        return mutate("REMNANT_STATUS_ADJUSTMENT",id,"UNAUTHENTICATED_LOCAL",() -> updateStatusInternal(id, status));
    }

    private boolean updateStatusInternal(String id, String status) {
        ensureMaterialNotReserved("remnant",id,null);
        if (id == null) return false;
        RemnantStock item = remnantPool.get(id);
        if (item != null) {
            if("LOST".equals(item.getStatus()) || "LOST".equals(status))throw new InventoryConflictException("盘亏与找回必须通过盘点单登记");
            if(status==null || !Set.of("AVAILABLE","QUARANTINED","SCRAPPED").contains(status))
                throw new IllegalArgumentException("状态调整仅支持可用、隔离或报废");
            if(!Objects.equals(item.getStatus(),status) && (Set.of("CONSUMED","SCRAPPED").contains(item.getStatus())
                    || ("QUARANTINED".equals(item.getStatus()) && "AVAILABLE".equals(status))))
                throw new InventoryConflictException("不能通过状态调整恢复已耗用、报废或待检料头");
            item.setStatus(status);
            return true;
        }
        return false;
    }
}
