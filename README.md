```bash
## STEPS TO RUN THE DOCKER CONTAINERS

## Step-1
## Pull your images from Docker Hub
docker pull muralikrishna1502887/offshore-proxy
docker pull muralikrishna1502887/ship-proxy

## To see all images
docker images


## Step-2
## We Make sure old containers are removed (for avoiding conflicts)
docker rm -f offshore ship 2>/dev/null || true


## Step-3
## Run Offshore Proxy container
docker run -d -p 9999:9999 --name offshore muralikrishna1502887/offshore-proxy


## Step-4
## Run Ship Proxy container

## If both containers are on the same Docker host: 
docker run -d -p 8080:8080 --name ship --link offshore:server \
-e OFFSHORE_HOST=server -e OFFSHORE_PORT=9999 muralikrishna1502887/ship-proxy


## If Offshore runs on a remote machine (replace OFFSHORE_IP with IP address):
docker run -d -p 8080:8080 --name ship \
-e OFFSHORE_HOST=OFFSHORE_IP -e OFFSHORE_PORT=9999 muralikrishna1502887/ship-proxy


## Step-5
## Testing
## On your host machine:

## HTTP Request
curl -x http://localhost:8080 http://httpforever.com/

## HTTPS Request
curl -I -x http://localhost:8080 https://example.com/

curl.exe -x http://localhost:8080 http://httpforever.com/
curl.exe -x http://localhost:8080 https://example.com/


## POST Request
curl -x http://localhost:8080 -X POST -d "a=1" http://httpbin.org/post

## Sequential Test
## Run two delayed requests at the same time to see sequential behavior:
time curl -x http://localhost:8080 http://httpbin.org/delay/5
time curl -x http://localhost:8080 http://httpbin.org/delay/5


