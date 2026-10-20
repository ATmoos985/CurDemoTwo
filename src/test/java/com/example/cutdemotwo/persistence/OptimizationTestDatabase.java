package com.example.cutdemotwo.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import java.util.UUID;

/** H2 by default; opt-in MySQL creates a fresh generated schema per test, never truncates a supplied schema. */
public final class OptimizationTestDatabase {
    private OptimizationTestDatabase() {}
    public static DriverManagerDataSource create() {
        String base=System.getProperty("cutdemo.test.mysql.url");
        String name="cutdemo_qa_"+UUID.randomUUID().toString().replace("-","");
        if(base==null)return new DriverManagerDataSource("jdbc:h2:mem:"+name+";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1","sa","");
        if(!base.matches("jdbc:mysql://(?:127\\.0\\.0\\.1|localhost):[0-9]+/"))
            throw new IllegalArgumentException("MySQL 测试 URL 必须指向本机独立端口且不带数据库名");
        String user=System.getProperty("cutdemo.test.mysql.user","root");
        String password=System.getProperty("cutdemo.test.mysql.password","");
        String options="?allowPublicKeyRetrieval=true&useSSL=false&connectionTimeZone=UTC";
        var admin=new DriverManagerDataSource(base+options,user,password);
        new JdbcTemplate(admin).execute("CREATE DATABASE "+name+" CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");
        return new DriverManagerDataSource(base+name+options,user,password);
    }
}
