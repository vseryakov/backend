#!/bin/bash

exec node app.js -watch $(pwd) -watch $(pwd) -web -log debug -etc-dir $(pwd)/etc -web-path $(pwd)/web $@

