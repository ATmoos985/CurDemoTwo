package com.example.cutdemotwo.persistence;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.nio.file.Path;

/** 工作台草案持久化配置：跟随库存存储模式自动启用独立文件目录或数据库表，绝不共用库存锁。 */
@Configuration
public class WorkbenchDraftConfiguration {

    @Bean(destroyMethod = "close")
    WorkbenchDraftStore workbenchDraftStore(
            InventoryStore inventory,
            ObjectProvider<DataSource> source,
            @Value("${cutdemo.workbench.drafts.path:${cutdemo.state.path:data/cutdemo-state.json}.drafts}") String path
    ) {
        // 先解析 InventoryStore 以确保 mysql 模式下 Flyway V11 迁移已执行完毕。
        return inventory.shared()
                ? new JdbcWorkbenchDraftStore(source.getObject())
                : new FileWorkbenchDraftStore(Path.of(path));
    }
}
