package com.example.cutdemotwo.persistence;

import com.zaxxer.hikari.*;
import org.flywaydb.core.Flyway;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.*;
import javax.sql.DataSource;

@Configuration
public class InventoryConfiguration {
    @Bean
    @ConditionalOnProperty(name = "cutdemo.storage", havingValue = "file", matchIfMissing = true)
    InventoryStore fileStore(@Value("${cutdemo.state.path:data/cutdemo-state.json}") String path) {
        return new FileInventoryStore(path);
    }

    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(name = "cutdemo.storage", havingValue = "mysql")
    HikariDataSource inventoryDataSource(@Value("${cutdemo.database.url}") String url,
            @Value("${cutdemo.database.username}") String username, @Value("${cutdemo.database.password}") String password) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(url); config.setUsername(username); config.setPassword(password);
        config.setMaximumPoolSize(5); config.setConnectionTimeout(10000);
        return new HikariDataSource(config);
    }

    @Bean
    @ConditionalOnProperty(name = "cutdemo.storage", havingValue = "mysql")
    InventoryStore mysqlStore(DataSource dataSource) {
        Flyway.configure().dataSource(dataSource).cleanDisabled(true).load().migrate();
        return new JdbcInventoryStore(dataSource);
    }
}
