#!/bin/sh
set -eu
: "${CI_JOB_ID:?CI_JOB_ID is required}"
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"
case "$CI_JOB_ID" in *[!0-9]*|'') exit 1 ;; esac
case "$CI_COMMIT_SHA" in *[!0-9a-f]*|'') exit 1 ;; esac
image="callmind-ci:${CI_COMMIT_SHA}-${CI_JOB_ID}"
container="callmind-ci-${CI_JOB_ID}"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
docker build --tag "$image" .
docker run --detach --name "$container" --network none --memory 1g --cpus 1 \
  --tmpfs /app/data:rw,uid=10001,gid=10001,mode=0700 "$image" >/dev/null
ready=false
for n in $(seq 1 30); do
  if docker exec "$container" node -e 'fetch("http://127.0.0.1:3000/").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))'; then
    ready=true
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  docker logs --tail 60 "$container"
  exit 1
fi
docker exec "$container" node -e 'const fs=require("fs"); require("sherpa-onnx-node"); const p="/app/models/uzbek-zipformer/"; for(const k of ["encoder-epoch-35-avg-10-chunk-16-left-128.int8.onnx","decoder-epoch-35-avg-10-chunk-16-left-128.int8.onnx","joiner-epoch-35-avg-10-chunk-16-left-128.int8.onnx","tokens.txt"]) if(!fs.existsSync(p+k)) throw Error("Missing model file: "+k); console.log("Native module and model files verified")'
echo "Isolated HTTP and Zipformer dependency checks passed for $CI_COMMIT_SHA"
