const { promisify } = require('util');
const express = require('express');
const { assert } = require('chai').use(require('chai-as-promised'));
const request = require('request-promise-native').defaults({
  simple: false,
  resolveWithFullResponse: true,
});

const appSession = require('../lib/appSession');
const { get: getConfig } = require('../lib/config');
const { create: createServer } = require('./fixture/server');
const redis = require('redis-mock');
const { getKeyStore, signCookie } = require('../lib/crypto');
const RedisStore = require('connect-redis')({ Store: class Store {} });

const defaultConfig = {
  clientID: '__test_client_id__',
  clientSecret: '__test_client_secret__',
  issuerBaseURL: 'https://op.example.com',
  baseURL: 'http://example.org',
  secret: '__test_secret__',
  errorOnRequiredAuth: true,
  session: {
    signSessionStoreCookie: true,
  },
};

const sessionData = () => {
  const epoch = () => (Date.now() / 1000) | 0;
  const epochNow = epoch();
  const weekInSeconds = 7 * 24 * 60 * 60;

  return JSON.stringify({
    header: {
      uat: epochNow,
      iat: epochNow,
      exp: epochNow + weekInSeconds,
    },
    data: { sub: '__test_sub__' },
  });
};

const login = async (claims) => {
  const jar = request.jar();
  await request.post('/session', {
    baseUrl,
    jar,
    json: claims,
  });
  return jar;
};

const baseUrl = 'http://localhost:3000';

describe('appSession custom store', () => {
  let server;
  let redisClient;
  let signedCookieValue;

  const setup = async (config) => {
    redisClient = redis.createClient();
    const store = new RedisStore({ client: redisClient, prefix: '' });
    redisClient.asyncSet = promisify(redisClient.set).bind(redisClient);
    redisClient.asyncGet = promisify(redisClient.get).bind(redisClient);
    redisClient.asyncDbsize = promisify(redisClient.dbsize).bind(redisClient);
    redisClient.asyncTtl = promisify(redisClient.ttl).bind(redisClient);

    const conf = getConfig({
      ...defaultConfig,
      ...config,
      session: {
        ...defaultConfig.session,
        ...(config && config.session),
        store,
      },
    });

    const [key] = getKeyStore(conf.secret);
    signedCookieValue = signCookie('appSession', 'foo', key);

    server = await createServer(appSession(conf));
  };

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (redisClient) {
      await new Promise((resolve) => redisClient.flushall(resolve));
      await new Promise((resolve) => redisClient.quit(resolve));
    }
  });

  it('should not create a session when there are no cookies', async () => {
    await setup();
    const res = await request.get('/session', { baseUrl, json: true });
    assert.isEmpty(res.body);
  });

  it('should not error for non existent sessions', async () => {
    await setup();
    const res = await request.get('/session', {
      baseUrl,
      json: true,
      headers: {
        cookie: 'appSession=__invalid_identity__',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.isEmpty(res.body);
  });

  it('should not error for non existent signed sessions', async () => {
    await setup();
    const conf = getConfig(defaultConfig);
    const [key] = getKeyStore(conf.secret);
    const res = await request.get('/session', {
      baseUrl,
      json: true,
      headers: {
        cookie: 'appSession=' + signCookie('appSession', 'foo', key),
      },
    });
    assert.equal(res.statusCode, 200);
    assert.isEmpty(res.body);
  });

  it('should get an existing session', async () => {
    await setup();
    await redisClient.asyncSet('foo', sessionData());
    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
      headers: {
        cookie: `appSession=${signedCookieValue}`,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { sub: '__test_sub__' });
    const [cookie] = jar.getCookies(baseUrl);
    assert.deepInclude(cookie, {
      key: 'appSession',
      value: signedCookieValue,
    });
  });

  it('should set ttl for compatible session stores', async () => {
    const twoDays = 172800;
    await setup({ session: { rolling: false, absoluteDuration: twoDays } });
    await redisClient.asyncSet('foo', sessionData());
    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
      headers: {
        cookie: `appSession=${signedCookieValue}`,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { sub: '__test_sub__' });
    assert.equal(res.statusCode, 200);
    const ttl = await redisClient.asyncTtl('foo');
    assert.closeTo(ttl, twoDays, 10 * 1000);
  });

  it('should not populate the store when there is no session', async () => {
    await setup();
    await request.get('/session', {
      baseUrl,
      json: true,
    });
    assert.equal(await redisClient.asyncDbsize(), 0);
  });

  it('should get a new session', async () => {
    await setup();
    const jar = await login({ sub: '__foo_user__' });
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { sub: '__foo_user__' });
    assert.equal(await redisClient.asyncDbsize(), 1);
  });

  it('should destroy an existing session', async () => {
    await setup({ idpLogout: false });
    await redisClient.asyncSet('foo', sessionData());
    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
      headers: {
        cookie: `appSession=${signedCookieValue}`,
      },
    });
    assert.deepEqual(res.body, { sub: '__test_sub__' });
    await request.post('/session', {
      baseUrl,
      jar,
      json: {},
    });
    const loggedOutRes = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
    });
    assert.isEmpty(loggedOutRes.body);
    assert.isEmpty(jar.getCookies(baseUrl));
    assert.equal(await redisClient.asyncDbsize(), 0);
  });

  it('uses custom session id generator when provided', async () => {
    const immId = 'apple';
    await setup({
      session: { genid: () => Promise.resolve(immId) },
    });
    const jar = await login({
      sub: '__foo_user__',
      role: 'test',
      userid: immId,
    });
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
    });
    assert.equal(res.statusCode, 200);
    const storedSessionJson = await redisClient.asyncGet(immId);
    const { data: sessionValues } = JSON.parse(storedSessionJson);
    assert.deepEqual(sessionValues, {
      sub: '__foo_user__',
      role: 'test',
      userid: immId,
    });
    assert.equal(await redisClient.asyncDbsize(), 1);
  });

  it('should handle storage errors', async () => {
    const store = {
      get(id, cb) {
        process.nextTick(() => cb(null, JSON.parse(sessionData())));
      },
      async set(id, val, cb) {
        process.nextTick(() => cb(new Error('storage error')));
      },
      async destroy(id, cb) {
        process.nextTick(() => cb());
      },
    };

    const conf = getConfig({
      ...defaultConfig,
      session: { store },
    });

    server = await createServer(appSession(conf));

    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
      headers: {
        cookie: `appSession=${signedCookieValue}`,
      },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.err.message, 'storage error');
  });

  it('should not throw if another mw writes the header', async () => {
    const app = express();

    redisClient = redis.createClient();
    const store = new RedisStore({ client: redisClient, prefix: '' });
    await promisify(redisClient.set).bind(redisClient)('foo', sessionData());

    const conf = getConfig({
      ...defaultConfig,
      session: { ...defaultConfig.session, store },
    });
    app.use(appSession(conf));

    const [key] = getKeyStore(conf.secret);
    const cookieValue = signCookie('appSession', 'foo', key);

    app.get('/', (req, res, next) => {
      res.json(req.appSession);
      next();
    });

    app.use((req, res, next) => {
      if (!res.headersSent) {
        res.writeHead(200);
      }
      next();
    });

    server = await new Promise((resolve) => {
      const server = app.listen(3000, () => resolve(server));
    });

    await assert.becomes(
      request.get('/', {
        baseUrl,
        json: true,
        headers: {
          cookie: `appSession=${cookieValue}`,
        },
        resolveWithFullResponse: false,
      }),
      { sub: '__test_sub__' }
    );
  });

  it('should not sign the session cookie if signSessionStoreCookie is false', async () => {
    await setup({ session: { signSessionStoreCookie: false } });
    await redisClient.asyncSet('foo', sessionData());
    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
      headers: {
        cookie: `appSession=foo`,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { sub: '__test_sub__' });
    const [cookie] = jar.getCookies(baseUrl);
    assert.deepInclude(cookie, {
      key: 'appSession',
      value: 'foo',
    });
  });

  it('should allow migration by signing the session cookie but not requiring it to be signed', async () => {
    await setup({
      session: {
        signSessionStoreCookie: true,
        requireSignedSessionStoreCookie: false,
      },
    });
    await redisClient.asyncSet('foo', sessionData());
    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
      headers: {
        cookie: `appSession=foo`,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { sub: '__test_sub__' });
    const [cookie] = jar.getCookies(baseUrl);
    assert.deepInclude(cookie, {
      key: 'appSession',
      value: signedCookieValue,
    });
  });

  it('should allow signed session cookies when not requiring it to be signed', async () => {
    await setup({
      session: {
        signSessionStoreCookie: true,
        requireSignedSessionStoreCookie: false,
      },
    });
    await redisClient.asyncSet('foo', sessionData());
    const jar = request.jar();
    const res = await request.get('/session', {
      baseUrl,
      jar,
      json: true,
      headers: {
        cookie: `appSession=${signedCookieValue}`,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { sub: '__test_sub__' });
    const [cookie] = jar.getCookies(baseUrl);
    assert.deepInclude(cookie, {
      key: 'appSession',
      value: signedCookieValue,
    });
  });
});
