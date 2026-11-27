package com.example.cutdemotwo.config;

import org.flywaydb.core.Flyway;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

/**
 * 安全凭据与全站操作审计存储双模式装配配置：
 * MySQL 模式下先幂等执行 Flyway 迁移并装配 JDBC 存储；File 模式下跟随 {@code cutdemo.state.path} 落盘独立子目录。
 */
@Configuration
public class SecurityPersistenceConfiguration {

    @Bean
    @ConditionalOnProperty(name = "cutdemo.storage", havingValue = "file", matchIfMissing = true)
    SecurityCredentialStore fileSecurityCredentialStore(
            @Value("${cutdemo.security.path:${cutdemo.state.path:data/cutdemo-state.json}.security}") String securityPath
    ) {
        return new FileSecurityCredentialStore(securityPath);
    }

    @Bean
    @ConditionalOnProperty(name = "cutdemo.storage", havingValue = "file", matchIfMissing = true)
    OperationAuditStore fileOperationAuditStore(
            @Value("${cutdemo.audit.path:${cutdemo.state.path:data/cutdemo-state.json}.audit}") String auditPath
    ) {
        return new FileOperationAuditStore(auditPath);
    }

    @Bean
    @ConditionalOnProperty(name = "cutdemo.storage", havingValue = "mysql")
    SecurityCredentialStore jdbcSecurityCredentialStore(DataSource dataSource) {
        Flyway.configure().dataSource(dataSource).cleanDisabled(true).load().migrate();
        return new JdbcSecurityCredentialStore(dataSource);
    }

    @Bean
    @ConditionalOnProperty(name = "cutdemo.storage", havingValue = "mysql")
    OperationAuditStore jdbcOperationAuditStore(DataSource dataSource) {
        Flyway.configure().dataSource(dataSource).cleanDisabled(true).load().migrate();
        return new JdbcOperationAuditStore(dataSource);
    }
}
