FROM ubuntu:24.04 AS solver
ARG PACKINGSOLVER_REVISION=3f4faae1a4bc42e2276c5729878933010d37ca14
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates cmake g++ git make curl
WORKDIR /solver
RUN git init && git remote add origin https://github.com/fontanf/packingsolver.git \
    && git fetch --depth 1 origin ${PACKINGSOLVER_REVISION} && git checkout --detach FETCH_HEAD
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DPACKINGSOLVER_BUILD_TEST=OFF -DPACKINGSOLVER_USE_CLP=OFF \
    && cmake --build build --target PackingSolver_rectangleguillotine_main --parallel 2 \
    && mkdir /output && cp build/src/rectangleguillotine/packingsolver_rectangleguillotine /output/ \
    && mkdir /output/licenses && cp LICENSE /output/licenses/LICENSE-packingsolver \
    && find build/_deps -maxdepth 2 -type f \( -iname 'license*' -o -iname 'copying*' -o -iname 'copyright*' \) \
       -exec cp --parents '{}' /output/licenses/ \;

FROM node:22-bookworm-slim AS frontend-tests
WORKDIR /workspace
COPY src ./src
RUN node --test src/test/js/*.test.mjs && touch /frontend-tests-passed

FROM maven:3.9-eclipse-temurin-17-noble AS build
WORKDIR /workspace
COPY --from=solver /output /opt/solver
COPY --from=frontend-tests /frontend-tests-passed /tmp/frontend-tests-passed
ENV PACKINGSOLVER_PATH=/opt/solver/packingsolver_rectangleguillotine
COPY pom.xml .
COPY src ./src
RUN mvn -B verify

FROM eclipse-temurin:17-jre-noble
WORKDIR /app
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends curl libstdc++6 libgomp1 \
    && groupadd --system cutdemo && useradd --system --gid cutdemo cutdemo \
    && mkdir /app/data && chown cutdemo:cutdemo /app/data
COPY --from=build /workspace/target/CutDemoTwo-0.0.1-SNAPSHOT.jar /app/app.jar
COPY --from=solver /output /opt/solver
ENV PACKINGSOLVER_PATH=/opt/solver/packingsolver_rectangleguillotine
USER cutdemo
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 CMD curl --fail --silent http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
