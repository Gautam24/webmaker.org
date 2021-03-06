var BadgeClient = require('badgekit-api-client');

module.exports = function (env) {

  // Error messages
  var errorHandlers = {
    unauthorized: function () {
      var err = new Error('You must be logged in to access this area.');
      err.status = 401;
      return err;
    },
    forbidden: function () {
      var err = new Error('You are not authorized to access this area. If you think you are supposed to have permissions, try logging out and in again, or contact help@webmaker.org');
      err.status = 403;
      return err;
    }
  };

  var badgeClient = new BadgeClient(env.get('BADGES_ENDPOINT'), {
    key: env.get('BADGES_KEY'),
    secret: env.get('BADGES_SECRET')
  });

  var permissionsModel = require('../lib/badges-permissions-model.js');

  return {
    middleware: {
      // Check if a use has at least a certain level of permissions
      // Can be 'admin', 'superMentor' or 'mentor'
      atleast: function (level) {
        var levels = ['isAdmin', 'isSuperMentor', 'isMentor'];
        return function (req, res, next) {
          var user = req.session.user;
          if (!level || levels.indexOf(level) <= -1) {
            var err = new Error('There is a problem with the permissions model: ' + level + ' is not a valid type of user.');
            return next(err);
          } else if (!user) {
            return next(errorHandlers.unauthorized());
          } else if (user.isAdmin) {
            return next();
          } else if (level === 'isSuperMentor' && (user.isAdmin || user.isSuperMentor)) {
            return next();
          } else if (level === 'isMentor' && (user.isAdmin || user.isSuperMentor || user.isMentor)) {
            return next();
          } else {
            return next(errorHandlers.forbidden());
          }
        };
      },
      // Does this user have permissions to issue, approve applications, see instances?
      hasPermissions: function (action) {
        return function (req, res, next) {
          var user = req.session.user;

          if (!user) {
            return next(errorHandlers.unauthorized());
          }

          var allowed = permissionsModel({
            badge: req.params.badge,
            user: req.session.user,
            action: action
          });

          if (!allowed) {
            return next(errorHandlers.forbidden());
          } else {
            return next();
          }

        };
      }
    },
    getAll: function (req, res, next) {
      badgeClient.getBadges({
        system: env.get('BADGES_SYSTEM')
      }, function (err, badges) {
        if (err) {
          return res.send(500, err.message);
        }
        res.json(badges);
      });
    },
    getInstances: function (req, res, next) {
      badgeClient.getBadgeInstances({
        system: env.get('BADGES_SYSTEM'),
        badge: req.params.badge
      }, function (err, instances) {

        // Errors
        if (err) {
          return res.send(500, err.message);
        }

        // We need to get the badge data too
        badgeClient.getBadge({
          system: env.get('BADGES_SYSTEM'),
          badge: req.params.badge
        }, function (err, badge) {
          if (err) {
            return res.send(500, err.message);
          }
          res.json({
            badge: badge,
            instances: instances
          });
        });

      });
    },
    deleteInstance: function (req, res, next) {
      badgeClient.deleteBadgeInstance({
        system: env.get('BADGES_SYSTEM'),
        badge: req.params.badge,
        email: req.params.email
      }, function (err, result) {
        if (err) {
          console.log(err.stack);
          return res.send(500, err.message);
        }
        res.send('DELETED');
      });
    },
    details: function (req, res, next) {

      badgeClient.getBadge({
        system: env.get('BADGES_SYSTEM'),
        badge: req.params.badge
      }, function (err, data) {

        if (err) {
          return res.render('badge-not-found.html', {
            page: 'search',
            view: 'badges'
          });
        }

        // Shim for https://bugzilla.mozilla.org/show_bug.cgi?id=1001161
        if (data.issuer && !data.issuer.imageUrl) {
          data.issuer.imageUrl = 'https://webmaker.org/img/logo-webmaker.png';
        }

        // Can the current user issue this badge?
        var canIssue = req.session.user && (req.session.user.isAdmin || (req.session.user.isSuperMentor && data.slug !== 'webmaker-super-mentor'));

        res.render('badge-detail.html', {
          page: req.params.badge,
          view: 'badges',
          badge: data,
          canIssue: canIssue
        });
      });

    },
    apply: function (req, res, next) {
      var application = {
        learner: req.session.user.email,
        evidence: [{
          reflection: req.body.evidence
        }]
      };

      badgeClient.addApplication({
        system: env.get('BADGES_SYSTEM'),
        badge: req.params.badge,
        application: application
      }, function (err, data) {
        if (err) {
          return res.send(500, err);
        }
        res.send(data);
      });
    },
    issue: function (req, res, next) {

      var query = {
        system: env.get('BADGES_SYSTEM'),
        email: req.body.email,
        badge: req.params.badge,
        comment: req.body.comment
      };

      badgeClient.createBadgeInstance(query, function (err, data) {
        if (err) {
          var errorString = err.toString();
          return res.send(500, {
            error: errorString
          });
        }
        res.send(data);
      });
    },
    claim: function (req, res, next) {

      var codeQuery = {
        system: env.get('BADGES_SYSTEM'),
        badge: req.params.badge,
        claimCode: req.body.claimcode
      };

      badgeClient.claimClaimCode(codeQuery, req.session.user.email, function (err, data) {
        if (err) {
          var errorString = err.message;
          if (err.code === 404) {
            errorString = 'The code "' + req.body.claimcode + '" could not be found';
          }
          return res.send(500, {
            error: errorString
          });
        }

        var instanceQuery = {
          system: env.get('BADGES_SYSTEM'),
          badge: req.params.badge,
          email: req.session.user.email
        };

        badgeClient.createBadgeInstance(instanceQuery, function (err, data) {
          if (err) {
            var errorString = err.message;
            return res.send(500, errorString);
          }

          res.send(data);
        });
      });
    },
    getApplications: function (req, res, next) {
      badgeClient.getApplications({
        system: env.get('BADGES_SYSTEM'),
        badge: req.params.badge
      }, function (err, raw) {
        if (err) {
          return res.send(500, err.message);
        }

        var applications = [];
        // No way to query for pending applications only.
        // See bug 1021009
        if (req.query.processed) {
          applications = raw;
        } else {
          raw.forEach(function (application) {
            if (!application.processed) {
              applications.push(application);
            }
          });
        }

        res.send(applications);
      });
    },
    submitReview: function (req, res, next) {
      var context = {
        system: env.get('BADGES_SYSTEM'),
        badge: req.params.badge,
        application: req.params.application,
        review: {
          author: req.session.email,
          comment: req.body.comment,
          reviewItems: req.body.reviewItems
        }
      };
      badgeClient.addReview(context, function (err, review) {
        if (err) {
          return res.send(500, err.message);
        }
        return res.send(200, 'Success');
      });
    }
  };
};
