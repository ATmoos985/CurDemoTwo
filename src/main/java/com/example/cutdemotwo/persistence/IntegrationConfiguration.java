package com.example.cutdemotwo.persistence;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import javax.sql.DataSource;
import java.nio.file.Path;

@Configuration
public class IntegrationConfiguration {
    @Bean(destroyMethod="close")
    IntegrationDeliveryStore integrationDeliveryStore(InventoryStore inventory,ObjectProvider<DataSource> source,
            @Value("${cutdemo.integration.path:${cutdemo.state.path:data/cutdemo-state.json}.integrations}") String path){
        return inventory.shared()?new JdbcIntegrationDeliveryStore(source.getObject()):new FileIntegrationDeliveryStore(Path.of(path));
    }
}
