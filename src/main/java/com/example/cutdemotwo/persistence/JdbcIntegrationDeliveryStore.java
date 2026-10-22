package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.IntegrationProgress;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;
import javax.sql.DataSource;
import java.util.*;
import java.util.function.Function;

/** Per-consumer row locking; no inventory save and no remote HTTP inside this transaction. */
public final class JdbcIntegrationDeliveryStore implements IntegrationDeliveryStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final JsonMapper json=JsonMapper.builder().build();
    private final boolean mysql;
    public JdbcIntegrationDeliveryStore(DataSource source){
        jdbc=new JdbcTemplate(source);transaction=new TransactionTemplate(new DataSourceTransactionManager(source));
        mysql="MySQL".equals(jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<String>)c->c.getMetaData().getDatabaseProductName()));
    }
    @Override public IntegrationProgress read(String consumer){
        var rows=jdbc.query("SELECT data_json FROM integration_delivery WHERE consumer_id=?",
                (rs,i)->json.readValue(rs.getString(1),IntegrationProgress.class),consumer);
        return rows.isEmpty()?IntegrationProgress.empty():rows.get(0);
    }
    @Override public <T> T update(String consumer,Function<IntegrationProgress,Change<T>> command){
        return transaction.execute(status->{
            jdbc.update("INSERT IGNORE INTO integration_delivery (consumer_id,version,data_json) VALUES (?,0,?)",
                    consumer,json.writeValueAsString(IntegrationProgress.empty()));
            var before=Objects.requireNonNull(jdbc.queryForObject("SELECT data_json FROM integration_delivery WHERE consumer_id=? FOR UPDATE",
                    (rs,i)->json.readValue(rs.getString(1),IntegrationProgress.class),consumer));
            var change=command.apply(before);
            if(!before.equals(change.progress()))jdbc.update("UPDATE integration_delivery SET version=?,data_json=? WHERE consumer_id=?",
                    before.version()+1,json.writeValueAsString(change.progress().withVersion(before.version()+1)),consumer);
            return change.result();
        });
    }
    @Override public long now(){
        if(mysql)return Objects.requireNonNull(jdbc.queryForObject("SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000",Long.class));
        return Objects.requireNonNull(jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(3)",java.sql.Timestamp.class)).getTime();
    }
}
