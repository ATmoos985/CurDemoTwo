FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /workspace
COPY pom.xml .
COPY src ./src
RUN mvn -B -DskipTests package

FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
RUN groupadd --system cutdemo && useradd --system --gid cutdemo cutdemo && mkdir /app/data && chown cutdemo:cutdemo /app/data
COPY --from=build /workspace/target/CutDemoTwo-0.0.1-SNAPSHOT.jar /app/app.jar
USER cutdemo
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
