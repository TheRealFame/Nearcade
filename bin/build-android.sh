#!/bin/bash
cd "$(dirname "$0")/.." || exit
npm run build:android
