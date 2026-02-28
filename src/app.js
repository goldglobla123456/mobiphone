const path = require('path');
const fs = require('fs');
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { t } = require('./i18n');
const {
  initDb,
  findUserByEmail,
  createUser,
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getCartCount,
  getCartItems,
  addToCart,
  updateCartItem,
  removeCartItem,
  createOrder,
  listOrdersByUser
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = String(process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const googleOAuthEnabled = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
);
const facebookOAuthEnabled = Boolean(
  process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET
);
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ext && ext.length <= 5 ? ext : '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || '').startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
  })
);
app.use(passport.initialize());

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.use(asyncHandler(async (req, res, next) => {
  if (!req.session.lang) {
    req.session.lang = 'vi';
  }

  res.locals.lang = req.session.lang;
  res.locals.t = (key) => t(res.locals.lang, key);
  res.locals.vnd = (amount) =>
    new Intl.NumberFormat(res.locals.lang === 'en' ? 'en-US' : 'vi-VN', {
      style: 'currency',
      currency: 'VND',
      maximumFractionDigits: 0
    }).format(Number(amount) || 0);
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  if (!req.session.user) {
    res.locals.cartCount = 0;
    return next();
  }

  res.locals.cartCount = await getCartCount(req.session.user.id);
  next();
}));

app.get('/language/:lang', (req, res) => {
  const selected = req.params.lang === 'en' ? 'en' : 'vi';
  req.session.lang = selected;
  return res.redirect(req.get('referer') || '/');
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    setFlash(req, 'error', 'Please login to continue.');
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    setFlash(req, 'error', 'Admin access required.');
    return res.redirect('/');
  }
  next();
}

function normalizeRichDescription(html) {
  const safeHtml = String(html || '').trim();
  const plain = safeHtml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { html: safeHtml, plain };
}

function getProfileEmail(profile) {
  const firstEmail = profile && Array.isArray(profile.emails) ? profile.emails[0] : null;
  return String((firstEmail && firstEmail.value) || '').trim().toLowerCase();
}

async function loginWithOAuthProfile(req, res, oauthUser) {
  const { provider, profile } = oauthUser;
  const email = getProfileEmail(profile);

  if (!email) {
    setFlash(req, 'error', `Cannot login with ${provider}: no email returned by provider.`);
    return res.redirect('/login');
  }

  const name = String(profile.displayName || email.split('@')[0] || 'User').trim();
  let user = await findUserByEmail(email);

  if (!user) {
    const oauthPasswordHash = bcrypt.hashSync(`oauth:${provider}:${profile.id}:${Date.now()}`, 10);
    user = await createUser(name, email, oauthPasswordHash);
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    is_admin: user.is_admin === 1
  };

  setFlash(req, 'success', `Logged in with ${provider} successfully.`);
  return res.redirect('/products');
}

if (googleOAuthEnabled) {
  passport.use(
    'google',
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${BASE_URL}/auth/google/callback`
      },
      (_accessToken, _refreshToken, profile, done) => {
        done(null, { provider: 'Google', profile });
      }
    )
  );
}

if (facebookOAuthEnabled) {
  passport.use(
    'facebook',
    new FacebookStrategy(
      {
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: `${BASE_URL}/auth/facebook/callback`,
        profileFields: ['id', 'displayName', 'emails']
      },
      (_accessToken, _refreshToken, profile, done) => {
        done(null, { provider: 'Facebook', profile });
      }
    )
  );
}

app.get('/', (_req, res) => {
  res.redirect('/products');
});

app.get('/products', asyncHandler(async (req, res) => {
  const category = (req.query.category || '').trim();
  const q = (req.query.q || '').trim();

  const products = await listProducts({ category, q });
  res.render('products', { products, category, q });
}));

app.get('/products/:id', asyncHandler(async (req, res) => {
  const product = await getProductById(req.params.id);
  if (!product) {
    return res.status(404).send('Product not found');
  }
  res.render('product-detail', { product });
}));

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register');
});

app.get('/auth/google', (req, res, next) => {
  if (!googleOAuthEnabled) {
    setFlash(req, 'error', 'Google login is not configured.');
    return res.redirect('/login');
  }
  return passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  if (!googleOAuthEnabled) {
    setFlash(req, 'error', 'Google login is not configured.');
    return res.redirect('/login');
  }

  return passport.authenticate('google', { session: false }, async (err, oauthUser) => {
    if (err || !oauthUser) {
      setFlash(req, 'error', 'Google login failed.');
      return res.redirect('/login');
    }

    try {
      return await loginWithOAuthProfile(req, res, oauthUser);
    } catch {
      setFlash(req, 'error', 'Google login failed.');
      return res.redirect('/login');
    }
  })(req, res, next);
});

app.get('/auth/facebook', (req, res, next) => {
  if (!facebookOAuthEnabled) {
    setFlash(req, 'error', 'Facebook login is not configured.');
    return res.redirect('/login');
  }
  return passport.authenticate('facebook', { scope: ['email'] })(req, res, next);
});

app.get('/auth/facebook/callback', (req, res, next) => {
  if (!facebookOAuthEnabled) {
    setFlash(req, 'error', 'Facebook login is not configured.');
    return res.redirect('/login');
  }

  return passport.authenticate('facebook', { session: false }, async (err, oauthUser) => {
    if (err || !oauthUser) {
      setFlash(req, 'error', 'Facebook login failed.');
      return res.redirect('/login');
    }

    try {
      return await loginWithOAuthProfile(req, res, oauthUser);
    } catch {
      setFlash(req, 'error', 'Facebook login failed.');
      return res.redirect('/login');
    }
  })(req, res, next);
});

app.post('/register', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!name || !email || password.length < 6) {
    setFlash(req, 'error', 'Invalid input. Password must be at least 6 characters.');
    return res.redirect('/register');
  }

  const exists = await findUserByEmail(email);
  if (exists) {
    setFlash(req, 'error', 'Email already in use.');
    return res.redirect('/register');
  }

  const hash = bcrypt.hashSync(password, 10);
  const user = await createUser(name, email, hash);

  req.session.user = { id: user.id, name, email, is_admin: false };
  setFlash(req, 'success', 'Registration successful. Welcome!');
  res.redirect('/');
}));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', {
    googleOAuthEnabled,
    facebookOAuthEnabled
  });
});

app.post('/login', asyncHandler(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  const user = await findUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    setFlash(req, 'error', 'Invalid email or password.');
    return res.redirect('/login');
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    is_admin: user.is_admin === 1
  };
  setFlash(req, 'success', 'Logged in successfully.');
  res.redirect('/');
}));

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/cart', requireAuth, asyncHandler(async (req, res) => {
  const items = await getCartItems(req.session.user.id);

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.render('cart', { items, total });
}));

app.post('/cart/add', requireAuth, asyncHandler(async (req, res) => {
  const productId = Number(req.body.product_id);
  const quantity = Math.max(1, Number(req.body.quantity || 1));

  const product = await getProductById(productId);
  if (!product) {
    setFlash(req, 'error', 'Product not found.');
    return res.redirect('/products');
  }

  const result = await addToCart(req.session.user.id, productId, quantity);
  if (!result.ok) {
    setFlash(req, 'error', result.error);
    return res.redirect(`/products/${productId}`);
  }

  setFlash(req, 'success', 'Item added to cart.');
  res.redirect('/cart');
}));

app.post('/cart/update', requireAuth, asyncHandler(async (req, res) => {
  const productId = Number(req.body.product_id);
  const quantity = Number(req.body.quantity || 1);

  const result = await updateCartItem(req.session.user.id, productId, quantity);
  if (!result.ok) {
    setFlash(req, 'error', result.error);
    return res.redirect('/cart');
  }

  setFlash(req, 'success', 'Cart updated.');
  res.redirect('/cart');
}));

app.post('/cart/remove', requireAuth, asyncHandler(async (req, res) => {
  const productId = Number(req.body.product_id);
  await removeCartItem(req.session.user.id, productId);
  setFlash(req, 'success', 'Item removed from cart.');
  res.redirect('/cart');
}));

app.get('/checkout', requireAuth, asyncHandler(async (req, res) => {
  const items = await getCartItems(req.session.user.id);

  if (!items.length) {
    setFlash(req, 'error', 'Your cart is empty.');
    return res.redirect('/cart');
  }

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.render('checkout', { items, total });
}));

app.post('/checkout', requireAuth, asyncHandler(async (req, res) => {
  const shippingName = (req.body.shipping_name || '').trim();
  const shippingPhone = (req.body.shipping_phone || '').trim();
  const shippingAddress = (req.body.shipping_address || '').trim();

  if (!shippingName || !shippingPhone || !shippingAddress) {
    setFlash(req, 'error', 'Please fill all shipping fields.');
    return res.redirect('/checkout');
  }

  const result = await createOrder(req.session.user.id, {
    shipping_name: shippingName,
    shipping_phone: shippingPhone,
    shipping_address: shippingAddress
  });

  if (!result.ok) {
    setFlash(req, 'error', result.error);
    return res.redirect('/cart');
  }

  res.render('checkout-success', { orderId: result.order.id });
}));

app.get('/orders', requireAuth, asyncHandler(async (req, res) => {
  const orders = await listOrdersByUser(req.session.user.id);
  res.render('orders', { orders });
}));

app.get('/admin/products', requireAdmin, asyncHandler(async (req, res) => {
  const products = await listProducts({ category: '', q: '' });
  res.render('admin-products', { products });
}));

app.get('/admin/products/new', requireAdmin, (req, res) => {
  res.render('admin-product-form', { product: null, action: '/admin/products/new' });
});

app.post('/admin/products/new', requireAdmin, upload.single('image_file'), asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  const { html: description, plain: plainDescription } = normalizeRichDescription(req.body.description);
  const price = Number(req.body.price || 0);
  const stock = Number(req.body.stock || 0);
  const category = (req.body.category || '').trim();
  const uploadedImagePath = req.file ? `/uploads/${req.file.filename}` : '';
  const finalImageUrl = uploadedImagePath;

  if (!name || !plainDescription || !category || price < 0 || stock < 0 || !finalImageUrl) {
    setFlash(req, 'error', 'Invalid product input.');
    return res.redirect('/admin/products/new');
  }

  await createProduct({
    name,
    description,
    price,
    image_url: finalImageUrl,
    stock,
    category
  });

  setFlash(req, 'success', 'Product created.');
  res.redirect('/admin/products');
}));

app.get('/admin/products/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
  const product = await getProductById(req.params.id);
  if (!product) return res.status(404).send('Product not found');
  res.render('admin-product-form', {
    product,
    action: `/admin/products/${product.id}/edit`
  });
}));

app.post('/admin/products/:id/edit', requireAdmin, upload.single('image_file'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body.name || '').trim();
  const { html: description, plain: plainDescription } = normalizeRichDescription(req.body.description);
  const price = Number(req.body.price || 0);
  const stock = Number(req.body.stock || 0);
  const category = (req.body.category || '').trim();
  const currentProduct = await getProductById(id);

  if (!currentProduct) {
    return res.status(404).send('Product not found');
  }

  const uploadedImagePath = req.file ? `/uploads/${req.file.filename}` : '';
  const finalImageUrl = uploadedImagePath || currentProduct.image_url;

  if (!name || !plainDescription || !category || price < 0 || stock < 0 || !finalImageUrl) {
    setFlash(req, 'error', 'Invalid product input.');
    return res.redirect(`/admin/products/${id}/edit`);
  }

  await updateProduct(id, {
    name,
    description,
    price,
    image_url: finalImageUrl,
    stock,
    category
  });

  setFlash(req, 'success', 'Product updated.');
  res.redirect('/admin/products');
}));

app.post('/admin/products/:id/delete', requireAdmin, asyncHandler(async (req, res) => {
  await deleteProduct(req.params.id);
  setFlash(req, 'success', 'Product deleted.');
  res.redirect('/admin/products');
}));

app.use((req, res) => {
  res.status(404).render('not-found');
});

app.use((err, req, res, next) => {
  if (!err) return next();
  setFlash(req, 'error', err.message || 'Upload failed.');
  if (req.path.includes('/admin/products')) {
    return res.redirect('back');
  }
  return res.redirect('/');
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Phone Store running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize Firebase data layer:', error.message);
    process.exit(1);
  });
