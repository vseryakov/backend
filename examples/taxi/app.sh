#!/bin/bash

exec /opt/local/bin/node app.js -watch -web -debug -etc-dir `pwd`/etc -web-dir `pwd`/web -spool-dir `pwd`/var $@

