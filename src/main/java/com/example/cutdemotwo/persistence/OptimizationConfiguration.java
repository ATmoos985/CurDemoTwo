package com.example.cutdemotwo.persistence;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import javax.sql.DataSource;
import java.nio.file.Path;

@Configuration
public class OptimizationConfiguration {
    @Bean(destroyMethod="")
    OptimizationJobStore optimizationJobStore(
            @Value("${cutdemo.jobs.storage:file}") String storage,
            @Value("${cutdemo.jobs.path:${cutdemo.state.path:data/cutdemo-state.json}.jobs}") String path,
            ObjectProvider<DataSource> source, InventoryStore inventory) {
        // Resolving InventoryStore first ensures the existing Flyway migration has completed.
        return switch(storage) {
            case "file" -> new FileOptimizationJobStore(Path.of(path));
            case "mysql" -> {
                var database=source.getIfAvailable();
                if(database==null)throw new IllegalStateException("MySQL 作业模式需要已配置的 cutdemo.storage=mysql 数据源");
                yield new JdbcOptimizationJobStore(database);
            }
            default -> throw new IllegalArgumentException("不支持的作业存储模式："+storage);
        };
    }
}
