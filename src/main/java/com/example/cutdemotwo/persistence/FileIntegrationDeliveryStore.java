package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.IntegrationProgress;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.nio.channels.*;
import java.io.IOException;
import java.util.function.Function;

/** Single application process, atomic replacement, independent of the inventory file. */
public final class FileIntegrationDeliveryStore implements IntegrationDeliveryStore {
    private final Path directory;
    private final FileChannel channel;
    private final FileLock lock;
    private final JsonMapper json=JsonMapper.builder().build();
    public FileIntegrationDeliveryStore(Path directory) {
        this.directory=directory.toAbsolutePath();FileChannel opened=null;
        try {
            Files.createDirectories(this.directory);
            opened=FileChannel.open(this.directory.resolve("delivery.lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);
            var acquired=opened.tryLock();
            if(acquired==null)throw new IllegalStateException("集成回执目录已被另一进程占用");
            channel=opened;lock=acquired;
        }catch(IOException|RuntimeException error){
            if(opened!=null)try{opened.close();}catch(IOException ignored){}
            throw new IllegalStateException("无法独占集成回执目录",error);
        }
    }
    private Path path(String consumer) {
        if(consumer==null || !consumer.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException("无效的集成方编号");
        return directory.resolve(consumer+".json");
    }
    @Override public synchronized IntegrationProgress read(String consumer) {
        Path file=path(consumer);
        try{return Files.exists(file)?json.readValue(file.toFile(),IntegrationProgress.class):IntegrationProgress.empty();}
        catch(RuntimeException error){throw new IllegalStateException("集成回执读取失败，原文件保留",error);}
    }
    @Override public synchronized <T> T update(String consumer,Function<IntegrationProgress,Change<T>> command) {
        var before=read(consumer);var change=command.apply(before);
        if(!before.equals(change.progress())) {
            Path temporary=null;
            try {
                temporary=Files.createTempFile(directory,"delivery-",".tmp");
                Files.write(temporary,json.writeValueAsBytes(change.progress().withVersion(before.version()+1)));
                try(var out=FileChannel.open(temporary,StandardOpenOption.WRITE)){out.force(true);}
                Files.move(temporary,path(consumer),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            }catch(IOException error){throw new IllegalStateException("集成回执保存失败",error);}
            finally{if(temporary!=null)try{Files.deleteIfExists(temporary);}catch(IOException ignored){}}
        }
        return change.result();
    }
    @Override public long now(){return System.currentTimeMillis();}
    @Override public void close(){try{lock.release();channel.close();}catch(IOException e){throw new IllegalStateException(e);}}
}
