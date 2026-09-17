#!/usr/bin/env node
import { main, processIo } from './main.js';
void main(process.argv.slice(2), process.env, processIo());
