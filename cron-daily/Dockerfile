# Minimal cron container. Railway invokes it on its cronSchedule.
FROM alpine:3.20

RUN apk add --no-cache curl bash ca-certificates

COPY ping.sh /usr/local/bin/ping.sh
RUN chmod +x /usr/local/bin/ping.sh

CMD ["/usr/local/bin/ping.sh"]
