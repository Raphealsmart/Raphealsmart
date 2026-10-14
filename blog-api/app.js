const express = require("express");
const mongoose = require("mongoose");
const { User, Article, Comment } = require("./models");

const app = express();
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/blog_api";
const PORT = process.env.PORT || 3000;

/* ---------- Helpers ---------- */    

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Any operation other than creating a user needs an existing user.
// The caller identifies themselves with the `x-user-id` header.
async function requireUser(req, res, next) {
  try {
    const userId = req.header("x-user-id");
    if (!userId || !isValidId(userId)) {
      return res.status(401).json({ message: "Valid x-user-id header required" });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/* ---------- Users ---------- */

// Create user (the only open route)
app.post("/users", async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) {
      return res.status(400).json({ message: "name and email are required" });
    }
    const user = await User.create({ name, email });
    res.status(201).json(user);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Email already in use" });
    }
    res.status(500).json({ message: err.message });
  }
});

// Update own profile (optional extra)
app.put("/users/:id", requireUser, async (req, res) => {
  try {
    if (req.params.id !== req.user.id) {
      return res.status(403).json({ message: "You can only edit your own profile" });
    }
    const { name, email } = req.body;
    if (name) req.user.name = name;
    if (email) req.user.email = email;
    await req.user.save();
    res.json(req.user);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Email already in use" });
    }
    res.status(500).json({ message: err.message });
  }
});

/* ---------- Articles ---------- */

// Create article
app.post("/articles", requireUser, async (req, res) => {
  try {
    const { title, content, category, tags } = req.body;
    if (!title || !content || !category) {
      return res.status(400).json({ message: "title, content and category are required" });
    }
    const article = await Article.create({
      title,
      content,
      category,
      tags: Array.isArray(tags) ? tags : [],
      author: req.user._id,
    });
    res.status(201).json(article);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all articles
// Optional query params: ?search=word&category=tech&author=<userId>&sort=newest
app.get("/articles", requireUser, async (req, res) => {
  try {
    const { search, category, author, sort } = req.query;
    const filter = {};

    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ title: rx }, { content: rx }, { tags: rx }];
    }
    if (category) {
      filter.category = new RegExp(`^${escapeRegex(category)}$`, "i");
    }
    if (author) {
      if (!isValidId(author)) {
        return res.status(400).json({ message: "Invalid author id" });
      }
      filter.author = author;
    }

    const order = sort === "oldest" ? 1 : -1; // newest first by default
    const articles = await Article.find(filter)
      .populate("author", "name email")
      .sort({ createdAt: order });

    res.json(articles);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get articles sorted by newest (declared before /articles/:id)
app.get("/articles/newest", requireUser, async (req, res) => {
  try {
    const articles = await Article.find()
      .populate("author", "name email")
      .sort({ createdAt: -1 });
    res.json(articles);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get article by ID (includes its comments)
app.get("/articles/:id", requireUser, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "Invalid article id" });
    }
    const article = await Article.findById(req.params.id).populate("author", "name email");
    if (!article) return res.status(404).json({ message: "Article not found" });

    const comments = await Comment.find({ article: article._id })
      .populate("author", "name")
      .sort({ createdAt: -1 });

    res.json({ ...article.toObject(), likesCount: article.likes.length, comments });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Edit article (author only)
app.put("/articles/:id", requireUser, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "Invalid article id" });
    }
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: "Article not found" });
    if (article.author.toString() !== req.user.id) {
      return res.status(403).json({ message: "Only the author can edit this article" });
    }

    const { title, content, category, tags } = req.body;
    if (title) article.title = title;
    if (content) article.content = content;
    if (category) article.category = category;
    if (Array.isArray(tags)) article.tags = tags;

    await article.save();
    res.json(article);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete article (author only) + its comments
app.delete("/articles/:id", requireUser, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "Invalid article id" });
    }
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: "Article not found" });
    if (article.author.toString() !== req.user.id) {
      return res.status(403).json({ message: "Only the author can delete this article" });
    }

    await Comment.deleteMany({ article: article._id });
    await article.deleteOne();
    res.json({ message: "Article deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Like / unlike an article (toggle)
app.post("/articles/:id/like", requireUser, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "Invalid article id" });
    }
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: "Article not found" });

    const alreadyLiked = article.likes.some((id) => id.toString() === req.user.id);
    if (alreadyLiked) {
      article.likes.pull(req.user._id);
    } else {
      article.likes.push(req.user._id);
    }
    await article.save();

    res.json({ liked: !alreadyLiked, likesCount: article.likes.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------- Comments ---------- */

// Add comment to an article
app.post("/articles/:id/comments", requireUser, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "Invalid article id" });
    }
    const { content } = req.body;
    if (!content) return res.status(400).json({ message: "content is required" });

    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: "Article not found" });

    const comment = await Comment.create({
      article: article._id,
      author: req.user._id,
      content,
    });
    res.status(201).json(comment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete comment (comment author or article author)
app.delete("/comments/:id", requireUser, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "Invalid comment id" });
    }
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    const article = await Article.findById(comment.article);
    const isCommentAuthor = comment.author.toString() === req.user.id;
    const isArticleAuthor = article && article.author.toString() === req.user.id;

    if (!isCommentAuthor && !isArticleAuthor) {
      return res.status(403).json({ message: "Not allowed to delete this comment" });
    }

    await comment.deleteOne();
    res.json({ message: "Comment deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------- Start ---------- */

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => console.error("DB connection error:", err));
