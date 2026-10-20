package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.optimization.StoredOptimizationJob;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.io.IOException;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

/** Explicit import holds the source directory lock, preserves raw evidence, and never recalculates. */
public final class OptimizationArchiveImport {
    private OptimizationArchiveImport() {}
    public record Archive(String fingerprint,String source,Map<String,String> originals,List<StoredOptimizationJob> jobs) {}

    public static int run(JdbcOptimizationJobStore target,Path source) {
        if(!Files.isDirectory(source))throw new IllegalArgumentException("作业归档源目录不存在；拒绝创建空目录");
        try(var files=new FileOptimizationJobStore(source)) {
            var jobs=files.load();
            if(jobs.isEmpty())throw new IllegalArgumentException("作业归档源目录为空");
            var originals=new TreeMap<String,String>();
            var keys=new HashSet<String>();
            for(var d:jobs) {
                validate(d);
                if(!keys.add(d.idempotencyKey()))throw new IllegalArgumentException("源归档包含重复幂等键");
                originals.put(d.job().id(),Files.readString(source.resolve(d.job().id()+".json")));
            }
            byte[] manifest=JsonMapper.builder().build().writeValueAsBytes(originals);
            String fingerprint=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(manifest));
            return target.importArchive(new Archive(fingerprint,source.toRealPath().toString(),originals,jobs));
        } catch(IOException | java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException("作业归档导入失败；源文件保持原样",error);
        }
    }
    private static void validate(StoredOptimizationJob d) {
        var j=d.job();
        if(j==null || d.input()==null || d.idempotencyKey()==null || !d.idempotencyKey().matches("[A-Za-z0-9._:-]{8,128}")
                || j.id()==null || !j.id().matches("[0-9a-f-]{36}") || !"2.0".equals(j.schemaVersion())
                || !Objects.equals(j.inputHash(),StoredOptimizationJob.inputHash(d.input()))
                || !Objects.equals(j.clientRequestId(),d.input().clientRequestId())
                || d.input().problem()==null || j.timeLimitSeconds()!=d.input().problem().timeLimitSeconds()
                || !Set.of("QUEUED","RUNNING","CANCEL_REQUESTED","SUCCEEDED","FAILED","CANCELLED","TIMED_OUT").contains(j.state()))
            throw new IllegalArgumentException("作业归档身份、输入哈希或状态无效");
        Instant.parse(j.createdAt());
        if(j.startedAt()!=null)Instant.parse(j.startedAt());
        if(j.finishedAt()!=null)Instant.parse(j.finishedAt());
        if(j.terminal()!=(j.finishedAt()!=null))throw new IllegalArgumentException("作业归档终态时间不一致");
        var result=d.result();
        if(result==null) {
            if(j.resultRef()!=null || "SUCCEEDED".equals(j.state()))throw new IllegalArgumentException("作业归档缺少引用的结果");
        } else if(!j.terminal() || !j.id().equals(result.jobId()) || !j.id().equals(result.id())
                || !Objects.equals(j.inputHash(),result.inputHash()) || !"PASSED".equals(result.validationStatus())
                || !Objects.equals(j.resultRef(),"/api/v2/optimization-results/"+j.id()))
            throw new IllegalArgumentException("作业归档结果与作业身份或验证状态不一致");
    }
}
